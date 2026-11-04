  const { text: textEvents, stream } = await import("@tessar/core");
  const { createChatSession } = await import("./sessions/chat.js");
  const session = await createChatSession(controller);
  await session.thread.create({ title: "First conversation" });
  let unsubscribe = () => {};
  const completed = new Promise<void>((resolve, reject) => {
    unsubscribe = session.subscribe(event => {
      if (event.type === textEvents.delta) process.stdout.write(event.payload.delta);
      if (event.type === stream.end) {
        if (event.payload.error) reject(Error(event.payload.error.message));
        else if (["failed", "cancelled"].includes(event.payload.status)) {
          reject(Error(event.payload.reason || `Execution ${event.payload.status}`));
        } else resolve();
      }
      if (event.type === stream.error) reject(Error(event.payload.error.message));
      if (event.type === stream.suspended) reject(Error("Execution needs a resume response"));
    });
  });
  try {
    await Promise.all([
      completed,
      session.followUp(process.argv.slice(2).join(" ") || "Say hello."),
    ]);
    console.log();
  } finally {
    unsubscribe();
  }
