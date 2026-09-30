// How a Wayground quiz reaches Wayground: the user imports the downloaded .xlsx by hand, or the QuizTool
// browser extension imports and publishes it. Client-only, never sent to the server.
export enum WaygroundDelivery {
  Download = 'download',
  Extension = 'extension'
}
