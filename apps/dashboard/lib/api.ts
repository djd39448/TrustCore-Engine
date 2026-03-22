export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3003';

export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ??
  API_BASE.replace(/^http/, 'ws');

export async function fetcher<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json() as Promise<T>;
}

export async function createTask(
  title: string,
  description?: string,
  assigned_to?: string
): Promise<{ id: string }> {
  const res = await fetch(`${API_BASE}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, description, assigned_to }),
  });
  if (!res.ok) throw new Error(`Create task failed: ${res.status}`);
  return res.json() as Promise<{ id: string }>;
}
