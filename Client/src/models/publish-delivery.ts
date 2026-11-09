// How a quiz reaches Wayground or Gimkit: the user imports the downloaded file (.xlsx / .csv) by hand, or the
// QuizTool browser extension imports and publishes it. Client-only, never sent to the server.
export enum PublishDelivery {
  Download = 'download',
  Extension = 'extension'
}
