{
  "name": "{{name}}",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24.22.1"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "npm run build && node --env-file=.env dist/main.js",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@tessar/core": "{{coreVersion}}",
    "@tessar/openai": "{{openaiVersion}}",
    "zod": "{{zodVersion}}"
  },
  "devDependencies": {
    "typescript": "{{typescriptVersion}}",
    "@types/node": "{{nodeTypesVersion}}"
  }
}
