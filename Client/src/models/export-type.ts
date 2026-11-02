export enum ExportType {
  GimKit,
  Blooket,
  Wayground,
  // Sent over the wire by ordinal: keep the order identical to ExportType in Server/internal/csvgen/options.go.
  GestureQuiz,
  // "Ghép bộ thủ": not a quiz but an exercise page the server builds from the lesson's words (see radicals-options.ts).
  Radicals
}
