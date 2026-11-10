const { createStorage } = await import("./storage.js");
const storage = createStorage();
const controller = createMainController({ agent, plugins: [storage.plugin] });
