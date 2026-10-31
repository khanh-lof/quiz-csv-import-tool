// Notification bodies render HTML, so text from a user, a job or the server goes through this.
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}
