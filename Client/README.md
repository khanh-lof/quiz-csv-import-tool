# QuizTool Client

Angular 22 single-page app (standalone components, ng-zorro-antd). The API it calls is in [`../Server`](../Server/);
the contract between them is in the root [AGENTS.md](../AGENTS.md).

```bash
npm install
npm start       # ng serve → http://localhost:4200, proxies /api to http://localhost:7071
npm test        # Karma + Jasmine
npm run build   # production build into dist/
```

The server must be running for anything that needs the API. See the root [README](../README.md) for setup.
