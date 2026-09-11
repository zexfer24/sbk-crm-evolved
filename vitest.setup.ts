import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";

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

/**
 * 29/8/2026: los waitFor/findBy de Testing Library traen 1000 ms de fábrica
 * (asyncUtilTimeout) — un plazo de reloj de pared que no escala con la carga.
 * Con hasta 7 forks compitiendo por 8 núcleos y la máquina ocupada, un waitFor
 * que atraviesa el debounce real de 300 ms del buscador del carrito
 * (sale-items-editor) se quedaba sin presupuesto: el archivo fallaba en la
 * suite completa y pasaba aislado. El testTimeout de 15s del config nunca
 * gobernó estas esperas. Subirlas a 5 s no alarga ningún test verde (waitFor
 * resuelve apenas se cumple la condición) y slowTestThreshold: 1000 sigue
 * delatando la degradación real. Import dinámico desde @testing-library/react
 * (no desde @testing-library/dom, que no está declarado en package.json) para
 * que los forks de entorno node no paguen react-dom en su setup.
 */
if (typeof window !== "undefined") {
  const { configure } = await import("@testing-library/react");
  configure({ asyncUtilTimeout: 5000 });
}

/**
 * 10/9/2026: jsdom conserva su `localStorage` durante todo un archivo de
 * pruebas, así que lo que guardaba un test (la píldora y el orden de la
 * bandeja, `sbk:inbox:{agentId}`) lo heredaba el siguiente. En el CI (Node
 * 22) eso dejó rojos 15 tests de inbox-sidebar.test.tsx desde el 6/9; en
 * local no se veía porque Node 26 no le daba `localStorage` a jsdom (ver
 * `execArgv` en vitest.config.ts). Se vacía ANTES de cada test para que cada
 * uno arranque limpio sin depender del orden de los `afterEach`. Si algún día
 * falta el almacenamiento, no se lanza desde acá: el contrato del entorno lo
 * cuida vitest.setup.test.ts.
 */
if (typeof window !== "undefined") {
  beforeEach(() => {
    try {
      globalThis.localStorage?.clear();
    } catch {
      // Un stub sin `clear` o un almacenamiento bloqueado: nada que vaciar.
    }
  });
}
