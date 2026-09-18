// ---------------------------------------------------------------------------
// El nombre del negocio, en un solo sitio (15/9/2026, Tarea 2 de "La voz de
// mostrador con nombre propio y el cierre de v1.1"). El operador confirmó
// "SBK Motors" ese día; hasta entonces "SBK Motorcycles" estaba escrito a
// mano en unos veinte archivos, y uno de ellos —el saludo del primer mensaje
// en prompt.ts— le llegaba al cliente en cada conversación nueva. Cambiar el
// nombre exigía tocar veinte sitios a mano y confiar en no olvidar ninguno;
// ahora es una constante que todos importan.
//
// Módulo puro a propósito: sin `import "server-only"` y sin ningún otro
// import. Lo usan tanto código de servidor (prompt.ts, classify.ts, tools.ts,
// knowledge.ts, invoices.ts) como de cliente (layout.tsx, login-form.tsx, las
// vistas del dashboard) — cualquier import acá arrastraría el mundo del lado
// que lo toque primero, igual que identity-guard.ts.
// ---------------------------------------------------------------------------

export const BUSINESS_NAME = "SBK Motors";

export const APP_TITLE = `${BUSINESS_NAME} CRM`;

// ---------------------------------------------------------------------------
// 18/9/2026, plan "Seba atiende el mostrador" (Requisito 1 del cliente): el
// agente de IA se llama "Seba", de mostrador — no "el asistente" ni "la IA".
// Vive acá por la misma razón que BUSINESS_NAME: lo necesita `prompt.ts`
// (servidor, el guion del modelo), `seba.ts` (el saludo literal) y el
// cliente (`message-bubble.tsx`, la etiqueta de la burbuja de la IA, y el
// menú "Enseñar a Seba…" que llega con R7).
// ---------------------------------------------------------------------------
export const AI_NAME = "Seba";
