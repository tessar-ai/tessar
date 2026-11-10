import { Controller, type Agent, type Plugin } from "@tessar/core";

export function create{{className}}Controller(options: { agent: Agent; plugins?: readonly Plugin[] }): Controller {
  return new Controller({ id: "{{name}}", ...options });
}
