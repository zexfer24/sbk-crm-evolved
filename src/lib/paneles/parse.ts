/**
 * Lectura defensiva del jsonb que devuelven las RPC de los paneles (plan
 * "Paneles", 13/11/2026). La forma exacta vive en `docs/paneles-contrato.md`;
 * cambiar una clave exige tocar este archivo, ese contrato y la migración en
 * el mismo commit.
 *
 * Por qué se valida en vez de hacer un `as PanelVentas`: PostgREST puede
 * entregar un `numeric` como string ("1234.50"), y una RPC desplegada a medias
 * (migración sin aplicar, clave renombrada) devuelve una forma distinta sin
 * ningún error de tipos. Cada `parsePanel*` lanza un `Error` en español que
 * nombra la ruta del campo roto; la pantalla lo atrapa y degrada SOLO ese
 * bloque, nunca el panel entero.
 *
 * `null` se respeta siempre ("no se puede calcular"): la pantalla pinta "—",
 * nunca un cero que parezca verdad (misma regla que `agent_day_summary`).
 * Puro: sin React ni Supabase.
 */

export type CanalId = "online" | "tienda";

// ---------------------------------------------------------------------------
// Ayudantes de validación
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function objeto(valor: unknown, ruta: string): Json {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    throw new Error(`${ruta}: se esperaba un objeto`);
  }
  return valor as Json;
}

function lista(valor: unknown, ruta: string): unknown[] {
  if (!Array.isArray(valor)) throw new Error(`${ruta}: se esperaba una lista`);
  return valor;
}

/** Número obligatorio; acepta el string numérico que PostgREST da a `numeric`. */
function numero(valor: unknown, ruta: string): number {
  if (typeof valor === "number" && Number.isFinite(valor)) return valor;
  if (typeof valor === "string" && valor.trim() !== "") {
    const convertido = Number(valor);
    if (Number.isFinite(convertido)) return convertido;
  }
  throw new Error(`${ruta}: se esperaba un número`);
}

function numeroONull(valor: unknown, ruta: string): number | null {
  return valor === null || valor === undefined ? null : numero(valor, ruta);
}

function texto(valor: unknown, ruta: string): string {
  if (typeof valor !== "string") throw new Error(`${ruta}: se esperaba un texto`);
  return valor;
}

function textoONull(valor: unknown, ruta: string): string | null {
  return valor === null || valor === undefined ? null : texto(valor, ruta);
}

function booleano(valor: unknown, ruta: string): boolean {
  if (typeof valor !== "boolean") throw new Error(`${ruta}: se esperaba verdadero o falso`);
  return valor;
}

function uno<T extends string>(valor: unknown, permitidos: readonly T[], ruta: string): T {
  if (typeof valor === "string" && (permitidos as readonly string[]).includes(valor)) return valor as T;
  throw new Error(`${ruta}: valor no válido (${permitidos.join(", ")})`);
}

function vectorDeNumeros(valor: unknown, ruta: string, columnas: number): number[] {
  const filas = lista(valor, ruta);
  if (filas.length !== columnas) throw new Error(`${ruta}: se esperaban ${columnas} valores y llegaron ${filas.length}`);
  return filas.map((celda, i) => numero(celda, `${ruta}[${i}]`));
}

/** Un valor de la lista, o `null` si falta (base vieja); uno que no está en la lista sí lanza. */
function nuloOUno<T extends string>(valor: unknown, permitidos: readonly T[], ruta: string): T | null {
  return valor === null || valor === undefined ? null : uno(valor, permitidos, ruta);
}

const CANALES = ["online", "tienda"] as const;

// ---------------------------------------------------------------------------
// panel_ventas
// ---------------------------------------------------------------------------

export interface CanalVentas {
  ingresos: number | null;
  envios: number;
  unidades: number;
  ticket: number | null;
  estimados: number;
  sin_monto: number;
}

export interface PanelVentas {
  granularidad: "hora" | "dia" | "mes";
  canales: Record<CanalId, CanalVentas>;
  serie: { t: string; online: number; tienda: number; envios_online: number; envios_tienda: number }[];
  /**
   * Solo con `granularidad = 'dia'` (si no, `[]`): un elemento por día del
   * rango, con 24 montos por hora de Caracas y canal. Alimenta la curva horaria
   * de la proyección del Dashboard.
   */
  perfil_horario: { dia: string; online: number[]; tienda: number[] }[];
  personas: {
    agent_id: string;
    nombre: string;
    rol: string;
    canal: CanalId;
    ingresos: number | null;
    envios: number;
    unidades: number;
  }[];
  top_repuestos: {
    codprod: string;
    nombre: string;
    unidades: number;
    ingresos: number | null;
    unidades_online: number;
    unidades_tienda: number;
  }[];
  tipo_precio: Record<CanalId, { promocion: number; estandar: number }>;
  estado: {
    transito: { envios: number; monto: number | null };
    error: { envios: number };
    sin_foto: number;
    duplicados: number;
  };
  recurrentes: {
    online: { compradores: number; regresan: number };
    tienda: { compradores: number; regresan: number };
    genericos_excluidos: number;
  };
}

function parseCanalVentas(v: unknown, ruta: string): CanalVentas {
  const o = objeto(v, ruta);
  return {
    ingresos: numeroONull(o.ingresos, `${ruta}.ingresos`),
    envios: numero(o.envios, `${ruta}.envios`),
    unidades: numero(o.unidades, `${ruta}.unidades`),
    ticket: numeroONull(o.ticket, `${ruta}.ticket`),
    estimados: numero(o.estimados, `${ruta}.estimados`),
    sin_monto: numero(o.sin_monto, `${ruta}.sin_monto`),
  };
}

export function parsePanelVentas(json: unknown): PanelVentas {
  const base = "Panel de ventas";
  const o = objeto(json, base);
  const canales = objeto(o.canales, `${base}.canales`);
  const tipoPrecio = objeto(o.tipo_precio, `${base}.tipo_precio`);
  const estado = objeto(o.estado, `${base}.estado`);
  const transito = objeto(estado.transito, `${base}.estado.transito`);
  const recurrentes = objeto(o.recurrentes, `${base}.recurrentes`);

  const parseTipoPrecio = (canal: CanalId) => {
    const t = objeto(tipoPrecio[canal], `${base}.tipo_precio.${canal}`);
    return {
      promocion: numero(t.promocion, `${base}.tipo_precio.${canal}.promocion`),
      estandar: numero(t.estandar, `${base}.tipo_precio.${canal}.estandar`),
    };
  };
  const parseRecurrentes = (canal: CanalId) => {
    const r = objeto(recurrentes[canal], `${base}.recurrentes.${canal}`);
    return {
      compradores: numero(r.compradores, `${base}.recurrentes.${canal}.compradores`),
      regresan: numero(r.regresan, `${base}.recurrentes.${canal}.regresan`),
    };
  };

  return {
    granularidad: uno(o.granularidad, ["hora", "dia", "mes"], `${base}.granularidad`),
    canales: {
      online: parseCanalVentas(canales.online, `${base}.canales.online`),
      tienda: parseCanalVentas(canales.tienda, `${base}.canales.tienda`),
    },
    serie: lista(o.serie, `${base}.serie`).map((fila, i) => {
      const ruta = `${base}.serie[${i}]`;
      const f = objeto(fila, ruta);
      // Un tramo sin ventas es un 0 verdadero (la serie trae todos los tramos
      // del rango); por eso, a diferencia de los ingresos de un canal, acá un
      // null se lee como 0 en vez de romper el gráfico entero.
      return {
        t: texto(f.t, `${ruta}.t`),
        online: numeroONull(f.online, `${ruta}.online`) ?? 0,
        tienda: numeroONull(f.tienda, `${ruta}.tienda`) ?? 0,
        envios_online: numero(f.envios_online, `${ruta}.envios_online`),
        envios_tienda: numero(f.envios_tienda, `${ruta}.envios_tienda`),
      };
    }),
    perfil_horario: lista(o.perfil_horario, `${base}.perfil_horario`).map((fila, i) => {
      const ruta = `${base}.perfil_horario[${i}]`;
      const f = objeto(fila, ruta);
      return {
        dia: texto(f.dia, `${ruta}.dia`),
        online: vectorDeNumeros(f.online, `${ruta}.online`, 24),
        tienda: vectorDeNumeros(f.tienda, `${ruta}.tienda`, 24),
      };
    }),
    personas: lista(o.personas, `${base}.personas`).map((fila, i) => {
      const ruta = `${base}.personas[${i}]`;
      const f = objeto(fila, ruta);
      return {
        agent_id: texto(f.agent_id, `${ruta}.agent_id`),
        nombre: texto(f.nombre, `${ruta}.nombre`),
        rol: texto(f.rol, `${ruta}.rol`),
        canal: uno(f.canal, CANALES, `${ruta}.canal`),
        ingresos: numeroONull(f.ingresos, `${ruta}.ingresos`),
        envios: numero(f.envios, `${ruta}.envios`),
        unidades: numero(f.unidades, `${ruta}.unidades`),
      };
    }),
    top_repuestos: lista(o.top_repuestos, `${base}.top_repuestos`).map((fila, i) => {
      const ruta = `${base}.top_repuestos[${i}]`;
      const f = objeto(fila, ruta);
      return {
        codprod: texto(f.codprod, `${ruta}.codprod`),
        nombre: texto(f.nombre, `${ruta}.nombre`),
        unidades: numero(f.unidades, `${ruta}.unidades`),
        ingresos: numeroONull(f.ingresos, `${ruta}.ingresos`),
        unidades_online: numero(f.unidades_online, `${ruta}.unidades_online`),
        unidades_tienda: numero(f.unidades_tienda, `${ruta}.unidades_tienda`),
      };
    }),
    tipo_precio: { online: parseTipoPrecio("online"), tienda: parseTipoPrecio("tienda") },
    estado: {
      transito: {
        envios: numero(transito.envios, `${base}.estado.transito.envios`),
        monto: numeroONull(transito.monto, `${base}.estado.transito.monto`),
      },
      error: { envios: numero(objeto(estado.error, `${base}.estado.error`).envios, `${base}.estado.error.envios`) },
      sin_foto: numero(estado.sin_foto, `${base}.estado.sin_foto`),
      duplicados: numero(estado.duplicados, `${base}.estado.duplicados`),
    },
    recurrentes: {
      online: parseRecurrentes("online"),
      tienda: parseRecurrentes("tienda"),
      genericos_excluidos: numero(recurrentes.genericos_excluidos, `${base}.recurrentes.genericos_excluidos`),
    },
  };
}

function redondearCentavos(monto: number): number {
  return Math.round(monto * 100) / 100;
}

/**
 * El "Resumen" de las tres vistas: online + tienda.
 *
 * - `ingresos` es null solo si los DOS canales son null; si uno lo es, vale el
 *   del otro (un canal sin monto no borra al que sí lo tiene).
 * - `ticket` NUNCA promedia los tickets de cada canal (un ticket de 1.000 en
 *   una venta y uno de 10 en nueve darían 505 en vez de 109): es los ingresos
 *   del resumen entre los envíos CON monto (`envios − sin_monto`, sumados), o
 *   null si no hay ninguno.
 */
export function sumaCanales(v: PanelVentas): CanalVentas {
  const { online, tienda } = v.canales;

  let ingresos: number | null;
  if (online.ingresos === null && tienda.ingresos === null) ingresos = null;
  else ingresos = redondearCentavos((online.ingresos ?? 0) + (tienda.ingresos ?? 0));

  const envios = online.envios + tienda.envios;
  const sinMonto = online.sin_monto + tienda.sin_monto;
  const enviosConMonto = envios - sinMonto;
  const ticket = ingresos !== null && enviosConMonto > 0 ? redondearCentavos(ingresos / enviosConMonto) : null;

  return {
    ingresos,
    envios,
    unidades: online.unidades + tienda.unidades,
    ticket,
    estimados: online.estimados + tienda.estimados,
    sin_monto: sinMonto,
  };
}

// ---------------------------------------------------------------------------
// panel_conversaciones
// ---------------------------------------------------------------------------

export interface PanelConversaciones {
  embudo: { escribieron: number; respondidas: number; con_carrito: number; compraron: number };
  resultados: {
    compraron: number;
    reclamo: number;
    carrito_sin_compra: number;
    solo_preguntaron: number;
    sin_respuesta: number;
  };
  conversion: {
    equipo: { atendidas: number; compraron: number };
    personas: {
      /** `null` para Seba (la IA): no es una fila de `agents`. */
      agent_id: string | null;
      nombre: string;
      rol: string;
      atendidas: number;
      compraron: number;
    }[];
  };
  /** Matriz 7 × 24: `[día 0=domingo..6][hora 0..23]`, hora de Caracas. */
  calor: { valores: number[][] };
}

export function parsePanelConversaciones(json: unknown): PanelConversaciones {
  const base = "Panel de conversaciones";
  const o = objeto(json, base);
  const embudo = objeto(o.embudo, `${base}.embudo`);
  const resultados = objeto(o.resultados, `${base}.resultados`);
  const conversion = objeto(o.conversion, `${base}.conversion`);
  const equipo = objeto(conversion.equipo, `${base}.conversion.equipo`);
  const calor = objeto(o.calor, `${base}.calor`);

  const filas = lista(calor.valores, `${base}.calor.valores`);
  if (filas.length !== 7) {
    throw new Error(`${base}.calor.valores: se esperaban 7 filas (días) y llegaron ${filas.length}`);
  }

  return {
    embudo: {
      escribieron: numero(embudo.escribieron, `${base}.embudo.escribieron`),
      respondidas: numero(embudo.respondidas, `${base}.embudo.respondidas`),
      con_carrito: numero(embudo.con_carrito, `${base}.embudo.con_carrito`),
      compraron: numero(embudo.compraron, `${base}.embudo.compraron`),
    },
    resultados: {
      compraron: numero(resultados.compraron, `${base}.resultados.compraron`),
      reclamo: numero(resultados.reclamo, `${base}.resultados.reclamo`),
      carrito_sin_compra: numero(resultados.carrito_sin_compra, `${base}.resultados.carrito_sin_compra`),
      solo_preguntaron: numero(resultados.solo_preguntaron, `${base}.resultados.solo_preguntaron`),
      sin_respuesta: numero(resultados.sin_respuesta, `${base}.resultados.sin_respuesta`),
    },
    conversion: {
      equipo: {
        atendidas: numero(equipo.atendidas, `${base}.conversion.equipo.atendidas`),
        compraron: numero(equipo.compraron, `${base}.conversion.equipo.compraron`),
      },
      personas: lista(conversion.personas, `${base}.conversion.personas`).map((fila, i) => {
        const ruta = `${base}.conversion.personas[${i}]`;
        const f = objeto(fila, ruta);
        return {
          agent_id: textoONull(f.agent_id, `${ruta}.agent_id`),
          nombre: texto(f.nombre, `${ruta}.nombre`),
          rol: texto(f.rol, `${ruta}.rol`),
          atendidas: numero(f.atendidas, `${ruta}.atendidas`),
          compraron: numero(f.compraron, `${ruta}.compraron`),
        };
      }),
    },
    calor: { valores: filas.map((fila, i) => vectorDeNumeros(fila, `${base}.calor.valores[${i}]`, 24)) },
  };
}

// ---------------------------------------------------------------------------
// panel_asesores
// ---------------------------------------------------------------------------

export interface PersonaAsesores {
  agent_id: string;
  nombre: string;
  rol: string;
  en_reparto: boolean;
  conversaciones: number;
  mensajes: number;
  contactos: number;
  episodios: number;
  primera_resp_mediana_min: number | null;
  primera_resp_p90_min: number | null;
  /** Fracción 0–1 de episodios respondidos en ≤ 5 minutos. */
  en_5min: number | null;
  envios: number;
  monto: number | null;
  unidades: number;
  envios_online: number;
  envios_tienda: number;
  reasignadas_desde: number;
  ultimo_mensaje: string | null;
  /** 24 enteros: mensajes enviados por hora de Caracas. */
  actividad_hora: number[];
}

export interface PanelAsesores {
  personas: PersonaAsesores[];
  seba: { mensajes: number; conversaciones: number; ultimo: string | null };
  equipo: { episodios: number; primera_resp_mediana_min: number | null; en_5min: number | null };
}

export function parsePanelAsesores(json: unknown): PanelAsesores {
  const base = "Panel de asesores";
  const o = objeto(json, base);
  const seba = objeto(o.seba, `${base}.seba`);
  const equipo = objeto(o.equipo, `${base}.equipo`);

  return {
    personas: lista(o.personas, `${base}.personas`).map((fila, i) => {
      const ruta = `${base}.personas[${i}]`;
      const f = objeto(fila, ruta);
      return {
        agent_id: texto(f.agent_id, `${ruta}.agent_id`),
        nombre: texto(f.nombre, `${ruta}.nombre`),
        rol: texto(f.rol, `${ruta}.rol`),
        en_reparto: booleano(f.en_reparto, `${ruta}.en_reparto`),
        conversaciones: numero(f.conversaciones, `${ruta}.conversaciones`),
        mensajes: numero(f.mensajes, `${ruta}.mensajes`),
        contactos: numero(f.contactos, `${ruta}.contactos`),
        episodios: numero(f.episodios, `${ruta}.episodios`),
        primera_resp_mediana_min: numeroONull(f.primera_resp_mediana_min, `${ruta}.primera_resp_mediana_min`),
        primera_resp_p90_min: numeroONull(f.primera_resp_p90_min, `${ruta}.primera_resp_p90_min`),
        en_5min: numeroONull(f.en_5min, `${ruta}.en_5min`),
        envios: numero(f.envios, `${ruta}.envios`),
        monto: numeroONull(f.monto, `${ruta}.monto`),
        unidades: numero(f.unidades, `${ruta}.unidades`),
        envios_online: numero(f.envios_online, `${ruta}.envios_online`),
        envios_tienda: numero(f.envios_tienda, `${ruta}.envios_tienda`),
        reasignadas_desde: numero(f.reasignadas_desde, `${ruta}.reasignadas_desde`),
        ultimo_mensaje: textoONull(f.ultimo_mensaje, `${ruta}.ultimo_mensaje`),
        actividad_hora: vectorDeNumeros(f.actividad_hora, `${ruta}.actividad_hora`, 24),
      };
    }),
    seba: {
      mensajes: numero(seba.mensajes, `${base}.seba.mensajes`),
      conversaciones: numero(seba.conversaciones, `${base}.seba.conversaciones`),
      ultimo: textoONull(seba.ultimo, `${base}.seba.ultimo`),
    },
    equipo: {
      episodios: numero(equipo.episodios, `${base}.equipo.episodios`),
      primera_resp_mediana_min: numeroONull(equipo.primera_resp_mediana_min, `${base}.equipo.primera_resp_mediana_min`),
      en_5min: numeroONull(equipo.en_5min, `${base}.equipo.en_5min`),
    },
  };
}

// ---------------------------------------------------------------------------
// panel_cola
// ---------------------------------------------------------------------------

export interface PanelCola {
  corte_dias: number;
  pendientes: number;
  sin_dueno: number;
  con_dueno: number;
  abandonadas: number;
  por_antiguedad: { menos_1h: number; de_1_a_4h: number; de_4_a_24h: number; de_1_a_7d: number };
  mas_viejo: { conversation_id: string; desde: string; contacto: string | null; asesor: string | null } | null;
  lista: {
    conversation_id: string;
    desde: string;
    contacto: string | null;
    asesor_id: string | null;
    asesor: string | null;
  }[];
}

export function parsePanelCola(json: unknown): PanelCola {
  const base = "Panel de cola";
  const o = objeto(json, base);
  const antig = objeto(o.por_antiguedad, `${base}.por_antiguedad`);

  let masViejo: PanelCola["mas_viejo"] = null;
  if (o.mas_viejo !== null && o.mas_viejo !== undefined) {
    const m = objeto(o.mas_viejo, `${base}.mas_viejo`);
    masViejo = {
      conversation_id: texto(m.conversation_id, `${base}.mas_viejo.conversation_id`),
      desde: texto(m.desde, `${base}.mas_viejo.desde`),
      contacto: textoONull(m.contacto, `${base}.mas_viejo.contacto`),
      asesor: textoONull(m.asesor, `${base}.mas_viejo.asesor`),
    };
  }

  return {
    corte_dias: numero(o.corte_dias, `${base}.corte_dias`),
    pendientes: numero(o.pendientes, `${base}.pendientes`),
    sin_dueno: numero(o.sin_dueno, `${base}.sin_dueno`),
    con_dueno: numero(o.con_dueno, `${base}.con_dueno`),
    abandonadas: numero(o.abandonadas, `${base}.abandonadas`),
    por_antiguedad: {
      menos_1h: numero(antig.menos_1h, `${base}.por_antiguedad.menos_1h`),
      de_1_a_4h: numero(antig.de_1_a_4h, `${base}.por_antiguedad.de_1_a_4h`),
      de_4_a_24h: numero(antig.de_4_a_24h, `${base}.por_antiguedad.de_4_a_24h`),
      de_1_a_7d: numero(antig.de_1_a_7d, `${base}.por_antiguedad.de_1_a_7d`),
    },
    mas_viejo: masViejo,
    lista: lista(o.lista, `${base}.lista`).map((fila, i) => {
      const ruta = `${base}.lista[${i}]`;
      const f = objeto(fila, ruta);
      return {
        conversation_id: texto(f.conversation_id, `${ruta}.conversation_id`),
        desde: texto(f.desde, `${ruta}.desde`),
        contacto: textoONull(f.contacto, `${ruta}.contacto`),
        asesor_id: textoONull(f.asesor_id, `${ruta}.asesor_id`),
        asesor: textoONull(f.asesor, `${ruta}.asesor`),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// panel_ventas_activas
// ---------------------------------------------------------------------------

export interface MontoActivo {
  monto: number | null;
  cantidad: number;
  sin_precio: number;
}

/**
 * De dónde sale una venta activa (22/11/2026, plan "Ventas activas"). Es el
 * flujo, no la persona: el canal se deduce de aquí (`presupuesto_inventario` →
 * tienda; los otros dos → online) y el equipo (rol de quien la armó) va aparte.
 */
export type OrigenActiva = "carrito_chat" | "presupuesto_chat" | "presupuesto_inventario";
/** Rol de quien armó la venta: `caja` → tienda; `sin_dato` si no se sabe. */
export type EquipoActiva = "online" | "tienda" | "sin_dato";
/** Estado de la ventana de 24 h de WhatsApp de la conversación de la venta. */
export type VentanaActiva = "abierta" | "por_cerrar" | "cerrada" | "no_aplica";

export const ORIGENES_ACTIVA: readonly OrigenActiva[] = ["carrito_chat", "presupuesto_chat", "presupuesto_inventario"];
export const EQUIPOS_ACTIVA: readonly EquipoActiva[] = ["online", "tienda", "sin_dato"];
export const VENTANAS_ACTIVA: readonly VentanaActiva[] = ["abierta", "por_cerrar", "cerrada", "no_aplica"];

export interface MontoCantidad {
  monto: number | null;
  cantidad: number;
}

/** Las claves que `panel_ventas_activas()` agregó el 22/11/2026; `null` si la base todavía no las trae. */
export interface DesgloseVentasActivas {
  tramos_48h: { tramo: "12h" | "24h" | "48h"; monto: number | null; cantidad: number }[];
  fuera_de_ventana: { carritos: number; presupuestos: number; por_origen: Record<OrigenActiva, number> };
  por_origen: Record<OrigenActiva, MontoActivo>;
  por_equipo: Record<EquipoActiva, MontoCantidad>;
  por_origen_equipo: Record<OrigenActiva, Record<EquipoActiva, MontoCantidad>>;
  por_ventana: Record<VentanaActiva, MontoCantidad>;
  por_canal_ventana: Record<CanalId, Record<VentanaActiva, MontoCantidad>>;
}

export interface PanelVentasActivas {
  total: number | null;
  presupuestos: MontoActivo;
  carritos: MontoActivo;
  por_canal: Record<CanalId, { monto: number | null; cantidad: number }>;
  antiguedad: { tramo: "24h" | "3d" | "7d" | "30d"; monto: number | null; cantidad: number }[];
  /** `null` con una base que todavía no trae las claves nuevas (migración sin aplicar). */
  desglose: DesgloseVentasActivas | null;
  items: {
    tipo: "presupuesto" | "carrito";
    id: string;
    canal: CanalId;
    responsable: string | null;
    cliente: string | null;
    monto: number | null;
    unidades: number;
    desde: string;
    origen: OrigenActiva | null;
    equipo: EquipoActiva | null;
    ventana: VentanaActiva | null;
    ventana_hasta: string | null;
    conversation_id: string | null;
  }[];
}

export function parsePanelVentasActivas(json: unknown): PanelVentasActivas {
  const base = "Panel de ventas activas";
  const o = objeto(json, base);
  const porCanal = objeto(o.por_canal, `${base}.por_canal`);

  const parseMontoActivo = (v: unknown, ruta: string): MontoActivo => {
    const m = objeto(v, ruta);
    return {
      monto: numeroONull(m.monto, `${ruta}.monto`),
      cantidad: numero(m.cantidad, `${ruta}.cantidad`),
      sin_precio: numero(m.sin_precio, `${ruta}.sin_precio`),
    };
  };
  const parsePorCanal = (canal: CanalId) => {
    const ruta = `${base}.por_canal.${canal}`;
    const c = objeto(porCanal[canal], ruta);
    return { monto: numeroONull(c.monto, `${ruta}.monto`), cantidad: numero(c.cantidad, `${ruta}.cantidad`) };
  };

  const parseCelda = (v: unknown, ruta: string): MontoCantidad => {
    const m = objeto(v, ruta);
    return { monto: numeroONull(m.monto, `${ruta}.monto`), cantidad: numero(m.cantidad, `${ruta}.cantidad`) };
  };
  /** Un objeto con una celda por cada clave permitida. */
  const porClaves = <K extends string, T>(v: unknown, claves: readonly K[], ruta: string, leer: (c: unknown, r: string) => T): Record<K, T> => {
    const m = objeto(v, ruta);
    const salida = {} as Record<K, T>;
    for (const k of claves) salida[k] = leer(m[k], `${ruta}.${k}`);
    return salida;
  };
  const parseDesglose = (): DesgloseVentasActivas | null => {
    // Base vieja: sin `por_origen` no se mira ninguna otra clave nueva.
    if (o.por_origen === undefined) return null;
    const fuera = objeto(o.fuera_de_ventana, `${base}.fuera_de_ventana`);
    return {
      tramos_48h: lista(o.tramos_48h, `${base}.tramos_48h`).map((fila, i) => {
        const ruta = `${base}.tramos_48h[${i}]`;
        const f = objeto(fila, ruta);
        return {
          tramo: uno(f.tramo, ["12h", "24h", "48h"], `${ruta}.tramo`),
          monto: numeroONull(f.monto, `${ruta}.monto`),
          cantidad: numero(f.cantidad, `${ruta}.cantidad`),
        };
      }),
      fuera_de_ventana: {
        carritos: numero(fuera.carritos, `${base}.fuera_de_ventana.carritos`),
        presupuestos: numero(fuera.presupuestos, `${base}.fuera_de_ventana.presupuestos`),
        por_origen: porClaves(fuera.por_origen, ORIGENES_ACTIVA, `${base}.fuera_de_ventana.por_origen`, numero),
      },
      por_origen: porClaves(o.por_origen, ORIGENES_ACTIVA, `${base}.por_origen`, parseMontoActivo),
      por_equipo: porClaves(o.por_equipo, EQUIPOS_ACTIVA, `${base}.por_equipo`, parseCelda),
      por_origen_equipo: porClaves(o.por_origen_equipo, ORIGENES_ACTIVA, `${base}.por_origen_equipo`, (c, r) =>
        porClaves(c, EQUIPOS_ACTIVA, r, parseCelda)
      ),
      por_ventana: porClaves(o.por_ventana, VENTANAS_ACTIVA, `${base}.por_ventana`, parseCelda),
      por_canal_ventana: porClaves(o.por_canal_ventana, CANALES, `${base}.por_canal_ventana`, (c, r) =>
        porClaves(c, VENTANAS_ACTIVA, r, parseCelda)
      ),
    };
  };

  return {
    total: numeroONull(o.total, `${base}.total`),
    presupuestos: parseMontoActivo(o.presupuestos, `${base}.presupuestos`),
    carritos: parseMontoActivo(o.carritos, `${base}.carritos`),
    por_canal: { online: parsePorCanal("online"), tienda: parsePorCanal("tienda") },
    antiguedad: lista(o.antiguedad, `${base}.antiguedad`).map((fila, i) => {
      const ruta = `${base}.antiguedad[${i}]`;
      const f = objeto(fila, ruta);
      return {
        tramo: uno(f.tramo, ["24h", "3d", "7d", "30d"], `${ruta}.tramo`),
        monto: numeroONull(f.monto, `${ruta}.monto`),
        cantidad: numero(f.cantidad, `${ruta}.cantidad`),
      };
    }),
    desglose: parseDesglose(),
    items: lista(o.items, `${base}.items`).map((fila, i) => {
      const ruta = `${base}.items[${i}]`;
      const f = objeto(fila, ruta);
      return {
        tipo: uno(f.tipo, ["presupuesto", "carrito"], `${ruta}.tipo`),
        id: texto(f.id, `${ruta}.id`),
        canal: uno(f.canal, CANALES, `${ruta}.canal`),
        responsable: textoONull(f.responsable, `${ruta}.responsable`),
        cliente: textoONull(f.cliente, `${ruta}.cliente`),
        monto: numeroONull(f.monto, `${ruta}.monto`),
        unidades: numero(f.unidades, `${ruta}.unidades`),
        desde: texto(f.desde, `${ruta}.desde`),
        origen: nuloOUno(f.origen, ORIGENES_ACTIVA, `${ruta}.origen`),
        equipo: nuloOUno(f.equipo, EQUIPOS_ACTIVA, `${ruta}.equipo`),
        ventana: nuloOUno(f.ventana, VENTANAS_ACTIVA, `${ruta}.ventana`),
        ventana_hasta: textoONull(f.ventana_hasta, `${ruta}.ventana_hasta`),
        conversation_id: textoONull(f.conversation_id, `${ruta}.conversation_id`),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// metas_venta
// ---------------------------------------------------------------------------

/** Fila de `public.metas_venta`: la meta de un canal desde un día en adelante. */
export interface MetaVenta {
  canal: CanalId;
  /** `YYYY-MM-DD`. */
  vigente_desde: string;
  monto_usd: number;
}

export function parseMetasVenta(json: unknown): MetaVenta[] {
  const base = "Metas de venta";
  return lista(json, base).map((fila, i) => {
    const ruta = `${base}[${i}]`;
    const f = objeto(fila, ruta);
    return {
      canal: uno(f.canal, CANALES, `${ruta}.canal`),
      vigente_desde: texto(f.vigente_desde, `${ruta}.vigente_desde`),
      monto_usd: numero(f.monto_usd, `${ruta}.monto_usd`),
    };
  });
}
