export interface Item { id: number; description: string; completed: boolean }
export interface List { id: number; title: string; items: Item[] }
export interface Summary { id: number; title: string }
export interface State { lists: Summary[]; selected: List | null }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('Invalid database response');
  return value as Record<string, unknown>;
}
function id(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 0xffffffff) throw new Error('Invalid record ID');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid record text');
  return value;
}
function unique(ids: number[]): void {
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate record IDs');
}
export function parseList(value: unknown): List {
  const list = object(value);
  if (!Array.isArray(list.items)) throw new Error('Invalid items');
  const items = list.items.map(value => {
    const item = object(value);
    if (typeof item.completed !== 'boolean') throw new Error('Invalid completion state');
    return { id: id(item.id), description: text(item.description), completed: item.completed };
  });
  unique(items.map(item => item.id));
  return { id: id(list.id), title: text(list.title), items };
}
export function parseState(value: unknown): State {
  const state = object(value);
  if (!Array.isArray(state.lists)) throw new Error('Invalid list summaries');
  const lists = state.lists.map(value => { const list = object(value); return { id: id(list.id), title: text(list.title) }; });
  unique(lists.map(list => list.id));
  const selected = state.selected === null ? null : parseList(state.selected);
  if (selected ? !lists.some(list => list.id === selected.id && list.title === selected.title) : lists.length !== 0) {
    throw new Error('Selected list does not match the summaries');
  }
  return { lists, selected };
}
