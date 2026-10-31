export default function inspectEntry(entry: { id: string; message: { role: string } }): string {
  return `${entry.id}:${entry.message.role}`;
}
