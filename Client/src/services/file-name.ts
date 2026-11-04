// A title as a download name: characters a file system rejects are dropped and spaces become dashes.
export function fileSafeLabel(label: string): string {
  return label.replace(/[\/:*?"<>|]/g, '').trim().replace(/\s+/g, '-') || 'QuizTool';
}
