  try {
    await controller.dispose();
  } finally {
    await storage.close();
  }
