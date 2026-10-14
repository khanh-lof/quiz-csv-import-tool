export enum ExportType {
  GimKit,
  Blooket,
  Wayground,
  // Sent over the wire by ordinal: keep the order identical to ExportType in Server/internal/csvgen/options.go.
  GestureQuiz
}
