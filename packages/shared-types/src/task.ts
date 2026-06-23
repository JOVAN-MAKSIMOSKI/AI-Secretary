// Task type shared across agent and web. Mirrors the `tasks` table.

export type TaskStatus = 'pending' | 'completed';

export interface Task {
  id: string;
  tenant_id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}
