import { useCallback, useEffect, useMemo, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import type { DateSelectArg, EventClickArg, EventInput } from "@fullcalendar/core";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getCachedCalendarEvents,
  getCachedTasks,
  listCalendarEvents,
  type CalendarEventResponse,
  createTask,
  deleteTask,
  listTasks,
  updateTask,
  type TaskResponse,
} from "../../connection/supabase-client";

function toCalendarInput(event: CalendarEventResponse): EventInput {
  return {
    id: event.eventId,
    title: event.title,
    start: event.startTime,
    end: event.endTime,
    extendedProps: {
      attendees: event.attendees,
      description: event.description,
    },
  };
}

export default function Calendar() {
  const [events, setEvents] = useState<EventInput[]>(() => getCachedCalendarEvents().map(toCalendarInput));
  const [tasks, setTasks] = useState<TaskResponse[]>(() => getCachedTasks());
  const [isLoading, setIsLoading] = useState(() => getCachedCalendarEvents().length === 0 && getCachedTasks().length === 0);
  const [isMutating, setIsMutating] = useState(false);
  const [isTaskMutating, setIsTaskMutating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [taskDraft, setTaskDraft] = useState("");

  const loadCalendarData = useCallback(async () => {
    try {
      const now = new Date();
      const rangeStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
      const rangeEnd = new Date(now.getFullYear(), now.getMonth() + 3, 0, 23, 59, 59).toISOString();
      const [calendarData, taskData] = await Promise.all([
        listCalendarEvents({
          timeMin: rangeStart,
          timeMax: rangeEnd,
          maxResults: 250,
        }),
        listTasks(),
      ]);

      setEvents(calendarData.map(toCalendarInput));
      setTasks(taskData);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load calendar workspace data.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    const run = async () => {
      if (!mounted) {
        return;
      }
      await loadCalendarData();
    };

    void run();
    const interval = window.setInterval(() => {
      void run();
    }, 30000);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, [loadCalendarData]);

  const handleDateSelect = async (selectionInfo: DateSelectArg) => {
    const title = window.prompt("New event title");
    const calendarApi = selectionInfo.view.calendar;
    calendarApi.unselect();

    if (!title?.trim()) {
      return;
    }

    setIsMutating(true);
    try {
      const created = await createCalendarEvent({
        title: title.trim(),
        startTime: selectionInfo.start.toISOString(),
        endTime: selectionInfo.end ? selectionInfo.end.toISOString() : selectionInfo.start.toISOString(),
      });

      setEvents((current) => [...current, toCalendarInput(created)]);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to create event in Google Calendar.");
    } finally {
      setIsMutating(false);
    }
  };

  const handleEventClick = async (clickInfo: EventClickArg) => {
    const shouldDelete = window.confirm(`Delete event \"${clickInfo.event.title}\"?`);
    if (!shouldDelete) {
      return;
    }

    setIsMutating(true);
    try {
      await deleteCalendarEvent(clickInfo.event.id);
      setEvents((current) => current.filter((event) => event.id !== clickInfo.event.id));
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to delete event from Google Calendar.");
    } finally {
      setIsMutating(false);
    }
  };

  const handleTaskCreate = async () => {
    const title = taskDraft.trim();
    if (!title) {
      return;
    }

    setIsTaskMutating(true);
    try {
      const created = await createTask({ title });
      setTasks((current) => [created, ...current]);
      setTaskDraft("");
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to create task.");
    } finally {
      setIsTaskMutating(false);
    }
  };

  const handleTaskToggle = async (task: TaskResponse) => {
    setIsTaskMutating(true);
    try {
      const updated = await updateTask(task.id, {
        status: task.status === "completed" ? "pending" : "completed",
      });
      setTasks((current) => current.map((item) => (item.id === task.id ? updated : item)));
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update task.");
    } finally {
      setIsTaskMutating(false);
    }
  };

  const handleTaskDelete = async (taskId: string) => {
    setIsTaskMutating(true);
    try {
      await deleteTask(taskId);
      setTasks((current) => current.filter((item) => item.id !== taskId));
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to delete task.");
    } finally {
      setIsTaskMutating(false);
    }
  };

  const pendingTasks = useMemo(() => tasks.filter((task) => task.status === "pending"), [tasks]);
  const completedTasks = useMemo(() => tasks.filter((task) => task.status === "completed"), [tasks]);

  const statusLabel = useMemo(() => {
    if (isLoading) {
      return "Syncing with Google Calendar...";
    }
    if (isMutating) {
      return "Saving changes to Google Calendar...";
    }
    if (isTaskMutating) {
      return "Syncing tasks...";
    }
    return "Connected to Google Calendar (auto-refresh every 30s).";
  }, [isLoading, isMutating, isTaskMutating]);

  return (
    <section className="m-2 h-full md:m-3">
      <div className="h-full rounded-xl border border-[var(--brand-border)] bg-[var(--brand-card)] p-3 shadow-sm shadow-slate-200/40 md:p-4">
        <h1 className="mb-3 text-lg font-medium text-[var(--brand-ink)]">Calendar</h1>
        <p className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-[var(--brand-text-muted)]">{statusLabel}</p>
        {errorMessage ? (
          <p className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{errorMessage}</p>
        ) : null}

        <div className="grid h-[calc(100%-2.25rem)] min-h-[520px] gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] p-2">
            <FullCalendar
              plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
              initialView="dayGridMonth"
              headerToolbar={{
                left: "prev,next today",
                center: "title",
                right: "dayGridMonth,timeGridWeek,timeGridDay",
              }}
              events={events}
              selectable
              selectAllow={() => !isMutating}
              selectMirror
              dayMaxEvents
              height="100%"
              select={handleDateSelect}
              eventClick={handleEventClick}
            />
          </div>

          <aside className="flex min-h-0 flex-col rounded-lg border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.14em] text-[var(--brand-text-muted)]">Tasks</p>
                <h2 className="mt-1 text-lg font-medium text-[var(--brand-ink)]">Workspace queue</h2>
              </div>
              <span className="rounded-full border border-[var(--brand-border)] bg-white px-2.5 py-1 text-xs text-[var(--brand-text-muted)]">
                {pendingTasks.length} open
              </span>
            </div>

            <div className="mt-4 flex gap-2">
              <input
                value={taskDraft}
                onChange={(event) => setTaskDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleTaskCreate();
                  }
                }}
                placeholder="Add a task"
                className="flex-1 rounded-md border border-[var(--brand-border)] bg-white px-3 py-2 text-sm text-[var(--brand-ink)] outline-none ring-0 placeholder:text-[var(--brand-text-muted)]"
              />
              <button
                type="button"
                onClick={() => void handleTaskCreate()}
                disabled={isTaskMutating}
                className="rounded-md bg-[var(--brand-teal)] px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                Add
              </button>
            </div>

            <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
              <div className="space-y-2">
                {pendingTasks.map((task) => (
                  <div key={task.id} className="rounded-lg border border-[var(--brand-border)] bg-white px-3 py-3">
                    <div className="flex items-start gap-3">
                      <button
                        type="button"
                        onClick={() => void handleTaskToggle(task)}
                        className="mt-0.5 h-4 w-4 rounded-full border border-[var(--brand-border)] bg-[var(--brand-surface)]"
                        aria-label={`Mark ${task.title} complete`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-[var(--brand-ink)]">{task.title}</p>
                        {task.notes ? <p className="mt-1 text-xs text-[var(--brand-text-muted)]">{task.notes}</p> : null}
                        {task.due_at ? (
                          <p className="mt-1 text-xs text-[var(--brand-text-muted)]">Due {new Date(task.due_at).toLocaleString()}</p>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleTaskDelete(task.id)}
                        className="text-xs text-[var(--brand-text-muted)] hover:text-[var(--brand-ink)]"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}

                {!pendingTasks.length ? (
                  <div className="rounded-lg border border-dashed border-[var(--brand-border)] px-3 py-6 text-center text-sm text-[var(--brand-text-muted)]">
                    No open tasks.
                  </div>
                ) : null}
              </div>

              {completedTasks.length ? (
                <div className="mt-5">
                  <p className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-[var(--brand-text-muted)]">Completed</p>
                  <div className="space-y-2">
                    {completedTasks.map((task) => (
                      <div key={task.id} className="rounded-lg border border-[var(--brand-border)] bg-white/70 px-3 py-3 opacity-75">
                        <div className="flex items-start gap-3">
                          <button
                            type="button"
                            onClick={() => void handleTaskToggle(task)}
                            className="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-emerald-200 bg-emerald-500 text-[10px] text-white"
                            aria-label={`Mark ${task.title} pending`}
                          >
                            ✓
                          </button>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-[var(--brand-ink)] line-through">{task.title}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleTaskDelete(task.id)}
                            className="text-xs text-[var(--brand-text-muted)] hover:text-[var(--brand-ink)]"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}
