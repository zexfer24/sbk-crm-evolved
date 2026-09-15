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
