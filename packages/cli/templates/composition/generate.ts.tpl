  const result = await agent.generate(process.argv.slice(2).join(" ") || "Say hello.");
  for (const message of result.output) {
    for (const part of message.content) {
      if (part.type === "text") console.log(part.text);
    }
  }
