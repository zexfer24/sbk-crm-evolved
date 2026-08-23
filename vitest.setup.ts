import "@testing-library/jest-dom/vitest";

/**
 * jsdom no implementa `matchMedia`, y cualquier componente que pregunte por la
 * preferencia de tema del sistema explota al montarse. El sustituto responde
 * siempre "modo claro" y acepta oyentes que nunca se disparan: alcanza para
 * que los componentes monten, y quien necesite probar el cambio de tema puede
 * reemplazarlo en su propio archivo.
 */
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
