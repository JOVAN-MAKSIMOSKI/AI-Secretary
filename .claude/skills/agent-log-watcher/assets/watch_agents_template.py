#!/usr/bin/env python3
"""
Watch CloudWatch Logs from multiple Lambda-backed agents in real-time.
Polls all agent log groups simultaneously, displays color-coded output,
and reports per-invocation duration parsed from Lambda's own REPORT line.

Template from the agent-log-watcher skill. Before using: replace AGENTS
below with this project's real {label: lambda_function_name} pairs, and
set DEFAULT_REGION to wherever those functions actually run.
"""

import argparse
import re
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from statistics import mean
from typing import Dict, List

import boto3

# ---------------------------------------------------------------------------
# Project-specific config — edit this block for each project
# ---------------------------------------------------------------------------

# label -> Lambda function name (without the /aws/lambda/ prefix)
AGENTS = {
    "PLANNER": "<project>-planner",
    "TAGGER": "<project>-tagger",
    "REPORTER": "<project>-reporter",
    "CHARTER": "<project>-charter",
    "RETIREMENT": "<project>-retirement",
}

DEFAULT_REGION = "eu-central-1"

# ---------------------------------------------------------------------------
# Everything below works unchanged for any number of agents
# ---------------------------------------------------------------------------

# Color palette auto-assigned per agent, so this scales past five agents
_PALETTE = ['\033[94m', '\033[93m', '\033[92m', '\033[96m', '\033[95m', '\033[33m', '\033[34m']
COLORS = {name: _PALETTE[i % len(_PALETTE)] for i, name in enumerate(AGENTS)}
COLORS.update({
    'ERROR': '\033[91m',   # Red
    'TIMING': '\033[35m',  # Purple
    'RESET': '\033[0m',
    'BOLD': '\033[1m',
})

LOG_GROUPS = {name: f"/aws/lambda/{function_name}" for name, function_name in AGENTS.items()}

# Matches the line Lambda automatically appends to CloudWatch Logs after
# every invocation, e.g.:
# REPORT RequestId: 8a1af80f-...  Duration: 842.31 ms  Billed Duration: 843 ms
#   Memory Size: 512 MB  Max Memory Used: 256 MB  Init Duration: 150.23 ms
REPORT_PATTERN = re.compile(
    r'REPORT RequestId:\s*(?P<request_id>\S+)\s+'
    r'Duration:\s*(?P<duration>[\d.]+)\s*ms\s+'
    r'Billed Duration:\s*(?P<billed_duration>[\d.]+)\s*ms\s+'
    r'Memory Size:\s*(?P<memory_size>\d+)\s*MB\s+'
    r'Max Memory Used:\s*(?P<memory_used>\d+)\s*MB'
    r'(?:\s+Init Duration:\s*(?P<init_duration>[\d.]+)\s*ms)?'
)


class AgentLogWatcher:
    """Watches CloudWatch Logs for all agents and reports per-invocation timing."""

    def __init__(self, region: str = DEFAULT_REGION, lookback_minutes: int = 5):
        self.logs_client = boto3.client('logs', region_name=region)
        self.lookback_minutes = lookback_minutes
        self.last_timestamps = {agent: 0 for agent in LOG_GROUPS}
        # Durations (ms) seen this session, per agent — powers the exit summary
        self.durations: Dict[str, List[float]] = defaultdict(list)

    def get_log_events(self, agent: str, start_time: int) -> List[Dict]:
        """Get new log events for a specific agent since start_time."""
        log_group = LOG_GROUPS[agent]

        try:
            response = self.logs_client.describe_log_streams(
                logGroupName=log_group,
                orderBy='LastEventTime',
                descending=True,
                limit=5  # the 5 most recently active streams
            )

            if not response.get('logStreams'):
                return []

            all_events = []
            for stream in response['logStreams']:
                stream_name = stream['logStreamName']
                try:
                    events_response = self.logs_client.filter_log_events(
                        logGroupName=log_group,
                        logStreamNames=[stream_name],
                        startTime=start_time,
                        limit=100
                    )
                    all_events.extend(events_response.get('events', []))
                except Exception:
                    # Stream may have been deleted or have no matching events
                    continue

            all_events.sort(key=lambda x: x['timestamp'])
            if all_events:
                self.last_timestamps[agent] = all_events[-1]['timestamp'] + 1

            return all_events

        except self.logs_client.exceptions.ResourceNotFoundException:
            print(f"{COLORS['ERROR']}Log group {log_group} not found{COLORS['RESET']}")
            return []
        except Exception as e:
            print(f"{COLORS['ERROR']}Error fetching logs for {agent}: {e}{COLORS['RESET']}")
            return []

    def format_message(self, agent: str, event: Dict) -> str:
        """Format a log message with color coding, or a timing line for REPORT events."""
        timestamp = datetime.fromtimestamp(event['timestamp'] / 1000).strftime('%H:%M:%S.%f')[:-3]
        message = event['message'].rstrip()
        agent_color = COLORS[agent]
        agent_label = f"{agent_color}[{agent:10}]{COLORS['RESET']}"

        report_match = REPORT_PATTERN.search(message)
        if report_match:
            duration_ms = float(report_match.group('duration'))
            self.durations[agent].append(duration_ms)

            init_duration = report_match.group('init_duration')
            cold_start_note = f", cold start +{float(init_duration):.0f}ms" if init_duration else ""

            timing_line = (
                f"{COLORS['TIMING']}{COLORS['BOLD']}"
                f"took {duration_ms / 1000:.2f}s ({duration_ms:.0f}ms){cold_start_note}"
                f"{COLORS['RESET']}"
            )
            return f"{timestamp} {agent_label} {timing_line}"

        if 'ERROR' in message or 'Exception' in message:
            message = f"{COLORS['ERROR']}{message}{COLORS['RESET']}"

        return f"{timestamp} {agent_label} {message}"

    def poll_agent(self, agent: str, start_time: int) -> List[str]:
        """Poll a single agent for new log events."""
        events = self.get_log_events(agent, start_time)
        return [self.format_message(agent, event) for event in events]

    def print_summary(self):
        """Print call count and min/avg/max duration per agent for this session."""
        print(f"\n{COLORS['BOLD']}--- Session timing summary ---{COLORS['RESET']}")
        for agent in LOG_GROUPS:
            samples = self.durations.get(agent, [])
            if not samples:
                print(f"  {COLORS[agent]}{agent:10}{COLORS['RESET']}  no invocations observed")
                continue
            print(
                f"  {COLORS[agent]}{agent:10}{COLORS['RESET']}  "
                f"{len(samples)} calls · avg {mean(samples):.0f}ms · "
                f"min {min(samples):.0f}ms · max {max(samples):.0f}ms"
            )

    def watch(self, poll_interval: int = 2):
        """Watch all agent logs continuously until interrupted."""
        print(f"{COLORS['BOLD']}Watching CloudWatch logs for: {', '.join(LOG_GROUPS)}{COLORS['RESET']}")
        print(f"Looking back {self.lookback_minutes} minutes initially")
        print(f"Polling every {poll_interval} seconds")
        print("Press Ctrl+C to stop\n")

        initial_start = int((datetime.now() - timedelta(minutes=self.lookback_minutes)).timestamp() * 1000)
        for agent in LOG_GROUPS:
            self.last_timestamps[agent] = initial_start

        try:
            while True:
                with ThreadPoolExecutor(max_workers=len(LOG_GROUPS)) as executor:
                    futures = {
                        executor.submit(self.poll_agent, agent, self.last_timestamps[agent]): agent
                        for agent in LOG_GROUPS
                    }
                    all_messages = []
                    for future in as_completed(futures):
                        all_messages.extend(future.result())

                all_messages.sort()
                for message in all_messages:
                    print(message)

                time.sleep(poll_interval)

        except KeyboardInterrupt:
            self.print_summary()
            print(f"\n{COLORS['BOLD']}Stopped watching logs{COLORS['RESET']}")
            sys.exit(0)
        except Exception as e:
            print(f"{COLORS['ERROR']}Error: {e}{COLORS['RESET']}")
            sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description='Watch CloudWatch logs from all agents, with per-call timing')
    parser.add_argument('--region', default=DEFAULT_REGION, help=f'AWS region (default: {DEFAULT_REGION})')
    parser.add_argument('--lookback', type=int, default=5, help='Minutes to look back initially (default: 5)')
    parser.add_argument('--interval', type=int, default=2, help='Polling interval in seconds (default: 2)')
    args = parser.parse_args()

    watcher = AgentLogWatcher(region=args.region, lookback_minutes=args.lookback)
    watcher.watch(poll_interval=args.interval)


if __name__ == "__main__":
    main()