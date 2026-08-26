// ---------------------------------------------------------------------------
// Claves de public.agent_tools.
//
// Vive aparte de src/lib/ai/agent-tools.ts —que es `server-only`, porque lee
// la base— para que el panel pueda mirar el estado de una herramienta sin
// copiarse la cadena a mano. Una clave escrita dos veces es una clave que
// algún día va a estar escrita de dos maneras.
//
// Contrato con la migración que siembra las filas: no se renombran.
// ---------------------------------------------------------------------------

export const TOOL_KEYS = {
  catalog: "buscar_repuesto",
  orderHistory: "buscar_historial_compras",
  knowledge: "consultar_biblioteca",
} as const;
