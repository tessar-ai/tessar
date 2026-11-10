export type Backend = "memory" | "libsql" | "postgresql" | "mongodb";

export interface ProjectOptions {
  controller: boolean;
  session: boolean;
  backend: Backend;
}

export const defaultProjectOptions: ProjectOptions = {
  controller: false,
  session: false,
  backend: "memory",
};
