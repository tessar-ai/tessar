# {{name}}

{{configuration}}

Install dependencies with `npm install`. Copy `.env.example` to `.env` and set OPENAI_API_KEY and OPENAI_MODEL.

Run `npm start -- "Your prompt"` or `npm run typecheck`. `npm run build` compiles to dist/.

To expose your runtime over HTTP, install `@tessar/server` and default-export
`new Tessar({ agents: [agent] })` or `new Tessar({ controllers: [controller] })`
from `src/index.ts`. Run `npx @tessar/cli dev` to start the Fastify server. Use
`server.configure(app)` to register custom Fastify routes, hooks or plugins.

Additional components created with `tessar generate` are not registered automatically. Import agents and tools where needed; pass plugin instances to a Controller. Call and await controller.initialize() before use, and controller.dispose() in a finally block. Plugins should use tessar.defer() to clean up resources they create. Tool templates require zod and @tessar/core.
