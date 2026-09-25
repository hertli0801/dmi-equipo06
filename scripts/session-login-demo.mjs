const API_KEY = process.env.DEMO_API_KEY; // (A) corregido

async function login(actorId) {
  const baseUrl = process.env.EXPO_PUBLIC_COURSE_BACKEND_URL ?? "http://127.0.0.1:4310";
  try {
    const response = await fetch(`${baseUrl}/v1/session/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId }),
    });
    if (!response.ok) {
      throw new Error("No fue posible iniciar sesion.");
    }
    const data = await response.json();
    console.log({ status: "authenticated", actorId: data.actorId });
    return data;
  } catch {
    throw new Error("No fue posible iniciar sesion."); // (D) corregido: nunca expone direccion/puerto/stack
  }
}

login("coordinator-1");