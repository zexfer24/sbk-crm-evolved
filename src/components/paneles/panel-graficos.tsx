"use client";

import { useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { anchoDeEtiqueta, gridValuesFor, pasoDeEtiquetas } from "@/lib/chart-scale";
import { useAnchoMedido } from "@/components/paneles/use-ancho-medido";

/**
 * Primitivas de gráficos SVG de los tres paneles (plan "Paneles", 13/11/2026).
 * Sin librería de gráficos: son cinco formas simples sobre `gridValuesFor`
 * (`chart-scale.ts`) y los tokens de `paneles.css` (`--pn-online`,
 * `--pn-tienda`, `--pn-seba`, `--pn-bien`…), que cambian solos con el tema.
 *
 * Reglas que comparten:
 * - Cada gráfico es un `role="img"` con un `aria-label` que trae el resumen en
 *   texto: quien no ve el SVG recibe la conclusión, no una lista de rectángulos.
 * - La lectura exacta de un punto sale por puntero, toque (pointer events
 *   cubren los tres) y teclado: el gráfico es enfocable y responde a flechas,
 *   Inicio, Fin y Esc. La lectura se pinta como `tooltip` y además se anuncia
 *   en una región `aria-live` aparte, porque los hijos de un `role="img"` no
 *   llegan a los lectores de pantalla.
 * - Un valor `null` ("no se puede calcular") NUNCA se dibuja como 0: el anillo
 *   pinta «—» y no traza arco.
 * - Los colores llegan como `var(--token)`; ningún color literal vive acá.
 *
 * jsdom no calcula layout: el mapeo puntero → punto usa el rectángulo de la
 * zona sensible, y un rectángulo de ancho 0 se ignora en vez de dar NaN.
 *
 * Píxeles reales (15/11/2026): las barras y la línea dibujan sobre un `viewBox`
 * del MISMO ancho que su contenedor (`useAnchoMedido`), no sobre uno fijo de
 * 600 que el navegador estiraba. Con el viewBox fijo el texto de los ejes
 * medía 30 px de alto a 1440 px y 8 px a 390 px (medido con Playwright, contra
 * los 11 px del resto de la interfaz) y los trazos se engordaban. Ahora 1
 * unidad del SVG = 1 px de pantalla; cuántos rótulos del eje X caben y el
 * margen de los rótulos del eje Y salen del ancho medido y del texto real.
 */

export interface SerieGrafico {
  id: string;
  nombre: string;
  /** Un `var(--token)`. */
  color: string;
}

const MARGEN_DER_MIN = 10;
const MARGEN_SUP = 10;
const MARGEN_INF = 24;
/**
 * Ancho máximo de una barra, en píxeles (15/11/2026). El ancho salía de dividir
 * la banda entre las barras sin tope: en «Ingresos mes a mes» de Analíticas, con
 * dos meses de datos, cada barra medía ~600 px a 1440 px de pantalla y eran dos
 * bloques que no se leían como un gráfico de barras. 56 px es lo bastante
 * ancho para que una barra se vea sólida y lo bastante angosto para que dos
 * barras sigan siendo barras; la banda (puntero, tooltip y rótulo del eje X)
 * conserva todo su ancho. Con 24 horas o 30 días las barras ya son más angostas
 * que esto y el tope no las toca.
 */
const ANCHO_MAX_BARRA = 56;
/** Separación entre barras vecinas de un mismo grupo (barras agrupadas). */
const SEPARACION_BARRAS = 2;

const redondear = (n: number) => String(Math.round(n));

/** Techo "redondo" para el eje: 1, 2, 2,5, 5 o 10 por una potencia de diez. */
function picoBonito(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  if (max <= 4) return Math.max(1, Math.ceil(max));
  const potencia = Math.pow(10, Math.floor(Math.log10(max)));
  const n = max / potencia;
  const paso = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return paso * potencia;
}

/**
 * Márgenes laterales según los rótulos que de verdad hay que pintar: el eje Y
 * necesita lo que mide su rótulo más ancho ("$12.500" no cabe en 44 px) y, en
 * una línea, los rótulos del eje X van centrados en el primer y el último
 * punto, así que sobresalen media etiqueta hacia cada lado.
 */
function margenesDe(pico: number, formato: (n: number) => string, etiquetasX: string[], centradasEnLosBordes: boolean) {
  const anchoY = Math.max(0, ...gridValuesFor(pico).map((v) => anchoDeEtiqueta(formato(v))));
  const mitadX = Math.max(0, ...etiquetasX.map((e) => anchoDeEtiqueta(e))) / 2;
  const izq = Math.ceil(Math.max(32, anchoY + 10, centradasEnLosBordes ? mitadX + 2 : 0));
  const der = Math.ceil(Math.max(MARGEN_DER_MIN, centradasEnLosBordes ? mitadX + 2 : 0));
  return { izq, der };
}

// ---------------------------------------------------------------------------
// Lectura exacta (cursor del teclado y del puntero) y su tooltip
// ---------------------------------------------------------------------------

interface LineaDeLectura {
  id: string;
  nombre: string;
  color: string | null;
  texto: string;
  /** Una línea en negrita (el total de una barra apilada). */
  destacada?: boolean;
}

interface Lectura {
  titulo: string;
  lineas: LineaDeLectura[];
}

/** Estado del punto activo + el manejo de teclado que comparten los gráficos con lectura. */
function useCursor(cantidad: number) {
  const [activa, setActiva] = useState<number | null>(null);

  function alTeclear(evento: KeyboardEvent<HTMLElement>) {
    if (cantidad === 0) return;
    const ultimo = cantidad - 1;
    let siguiente: number | null | undefined;
    switch (evento.key) {
      case "ArrowRight":
      case "ArrowDown":
        siguiente = activa === null ? 0 : Math.min(ultimo, activa + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        siguiente = activa === null ? ultimo : Math.max(0, activa - 1);
        break;
      case "Home":
        siguiente = 0;
        break;
      case "End":
        siguiente = ultimo;
        break;
      case "Escape":
        siguiente = null;
        break;
      default:
        return;
    }
    evento.preventDefault();
    setActiva(siguiente);
  }

  return { activa, setActiva, alTeclear, soltar: () => setActiva(null) };
}

function textoDeLectura(lectura: Lectura): string {
  return `${lectura.titulo}: ${lectura.lineas.map((l) => `${l.nombre} ${l.texto}`).join(", ")}`;
}

function Tooltip({ lectura, posicion }: { lectura: Lectura; posicion: number }) {
  // El tooltip se ancla a la posición del punto, sin salirse por los lados.
  const izquierda = Math.min(88, Math.max(12, posicion));
  return (
    <div role="tooltip" className="pn-tip" style={{ left: `${izquierda}%` }}>
      <b className="pn-tip__titulo">{lectura.titulo}</b>
      {lectura.lineas.map((linea) => (
        <span key={linea.id} className={linea.destacada ? "pn-tip__fila pn-tip__fila--total" : "pn-tip__fila"}>
          {linea.color && <i className="pn-tip__sw" style={{ background: linea.color }} aria-hidden="true" />}
          <span className="pn-tip__nombre">{linea.nombre}</span>
          <em className="pn-tip__valor lm-num">{linea.texto}</em>
        </span>
      ))}
    </div>
  );
}

/** El contenedor de un gráfico con lectura: imagen enfocable + tooltip + región viva. */
function MarcoGrafico({
  ariaLabel,
  lectura,
  posicion,
  onKeyDown,
  onSoltar,
  lienzoRef,
  children,
}: {
  ariaLabel: string;
  lectura: Lectura | null;
  /** Posición horizontal del punto activo, en % del ancho. */
  posicion: number;
  onKeyDown: (evento: KeyboardEvent<HTMLElement>) => void;
  onSoltar: () => void;
  /** El elemento cuyo ancho mide `useAnchoMedido`. */
  lienzoRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  return (
    <div className="pn-graf" onPointerLeave={onSoltar}>
      <div ref={lienzoRef} className="pn-graf__lienzo" role="img" aria-label={ariaLabel} tabIndex={0} onKeyDown={onKeyDown}>
        {children}
      </div>
      {lectura && <Tooltip lectura={lectura} posicion={posicion} />}
      <span className="pn-sr" aria-live="polite">
        {lectura ? textoDeLectura(lectura) : ""}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

export function Sparkline({
  valores,
  color = "var(--pn-online)",
  ariaLabel,
  alto = 32,
}: {
  valores: number[];
  color?: string;
  ariaLabel: string;
  alto?: number;
}) {
  const minimo = valores.length ? Math.min(...valores) : 0;
  const maximo = valores.length ? Math.max(...valores) : 0;
  const rango = maximo - minimo || 1;
  const margen = 3;
  const yDe = (v: number) => (maximo === minimo ? alto / 2 : alto - margen - ((v - minimo) / rango) * (alto - margen * 2));

  let puntos = "";
  if (valores.length === 1) {
    puntos = `0,${yDe(valores[0])} 100,${yDe(valores[0])}`;
  } else if (valores.length > 1) {
    puntos = valores.map((v, i) => `${((i / (valores.length - 1)) * 100).toFixed(2)},${yDe(v).toFixed(2)}`).join(" ");
  }

  return (
    <svg className="pn-spark" viewBox={`0 0 100 ${alto}`} preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
      {puntos && (
        <polyline
          points={puntos}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Ejes compartidos por barras y líneas
// ---------------------------------------------------------------------------

function Rejilla({
  pico,
  izq,
  plotW,
  plotH,
  formato,
}: {
  pico: number;
  izq: number;
  plotW: number;
  plotH: number;
  formato: (n: number) => string;
}) {
  return (
    <g className="pn-rejilla" aria-hidden="true">
      {gridValuesFor(pico).map((valor) => {
        const y = MARGEN_SUP + plotH - (valor / pico) * plotH;
        return (
          <g key={valor}>
            <line x1={izq} x2={izq + plotW} y1={y} y2={y} />
            <text x={izq - 6} y={y + 3.5} textAnchor="end">
              {formato(valor)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

// ---------------------------------------------------------------------------
// BarrasVerticales
// ---------------------------------------------------------------------------

export function BarrasVerticales({
  categorias,
  series,
  apiladas = false,
  formato = redondear,
  ariaLabel,
  alto = 180,
}: {
  categorias: { etiqueta: string; valores: number[] }[];
  series: SerieGrafico[];
  apiladas?: boolean;
  formato?: (n: number) => string;
  ariaLabel: string;
  alto?: number;
}) {
  const { activa, setActiva, alTeclear, soltar } = useCursor(categorias.length);
  const { ref: lienzoRef, ancho } = useAnchoMedido();

  const n = Math.max(categorias.length, 1);

  const valorDe = (categoria: { valores: number[] }, i: number) => Math.max(0, categoria.valores[i] ?? 0);
  const totalDe = (categoria: { valores: number[] }) => series.reduce((suma, _s, i) => suma + valorDe(categoria, i), 0);

  const maximo = categorias.reduce(
    (m, c) => Math.max(m, apiladas ? totalDe(c) : series.reduce((mm, _s, i) => Math.max(mm, valorDe(c, i)), 0)),
    0
  );
  const pico = picoBonito(maximo);
  const { izq, der } = margenesDe(pico, formato, [], false);
  const plotW = ancho - izq - der;
  const plotH = alto - MARGEN_SUP - MARGEN_INF;
  const banda = plotW / n;
  const relleno = banda * 0.22;
  const interior = banda - relleno;
  const separacion = apiladas ? 0 : SEPARACION_BARRAS;
  const anchoCasilla = apiladas ? interior : interior / Math.max(series.length, 1);
  // Cada barra visible mide a lo sumo `ANCHO_MAX_BARRA`; la casilla incluye su separación.
  const anchoBarra = Math.min(anchoCasilla, ANCHO_MAX_BARRA + separacion);
  const topada = anchoBarra < anchoCasilla;
  const anchoGrupo = apiladas ? anchoBarra : series.length * anchoBarra - separacion;
  // Sin tope, el relleno se reparte a los lados como siempre; con tope, el grupo se centra en su banda.
  const sangria = topada ? (banda - anchoGrupo) / 2 : relleno / 2;
  const altoDe = (v: number) => (v / pico) * plotH;
  // Cada rótulo va centrado en su banda: caben los que entren en `banda` px.
  const pasoEtiqueta = pasoDeEtiquetas(banda, Math.max(0, ...categorias.map((c) => anchoDeEtiqueta(c.etiqueta))));

  let lectura: Lectura | null = null;
  if (activa !== null && categorias[activa]) {
    const categoria = categorias[activa];
    const lineas: LineaDeLectura[] = series.map((s, i) => ({
      id: s.id,
      nombre: s.nombre,
      color: s.color,
      texto: formato(valorDe(categoria, i)),
    }));
    if (apiladas) lineas.push({ id: "total", nombre: "Total", color: null, texto: formato(totalDe(categoria)), destacada: true });
    lectura = { titulo: categoria.etiqueta, lineas };
  }
  const posicion = activa === null ? 50 : ((izq + banda * (activa + 0.5)) / ancho) * 100;

  return (
    <MarcoGrafico ariaLabel={ariaLabel} lectura={lectura} posicion={posicion} onKeyDown={alTeclear} onSoltar={soltar} lienzoRef={lienzoRef}>
      <svg className="pn-svg" viewBox={`0 0 ${ancho} ${alto}`} aria-hidden="true">
        <Rejilla pico={pico} izq={izq} plotW={plotW} plotH={plotH} formato={formato} />
        {categorias.map((categoria, c) => {
          const x0 = izq + c * banda;
          let acumulado = 0;
          return (
            <g key={`${categoria.etiqueta}-${c}`}>
              {activa === c && <rect className="pn-banda" x={x0} y={MARGEN_SUP} width={banda} height={plotH} />}
              {series.map((serie, s) => {
                const valor = valorDe(categoria, s);
                const h = altoDe(valor);
                const x = apiladas ? x0 + sangria : x0 + sangria + s * anchoBarra;
                const y = apiladas ? MARGEN_SUP + plotH - altoDe(acumulado + valor) : MARGEN_SUP + plotH - h;
                if (apiladas) acumulado += valor;
                return (
                  <rect
                    key={serie.id}
                    className="pn-barra"
                    data-serie={serie.id}
                    x={x}
                    y={y}
                    width={Math.max(anchoBarra - separacion, 1)}
                    height={h}
                    rx={3}
                    fill={serie.color}
                  />
                );
              })}
              {c % pasoEtiqueta === 0 && (
                <text className="pn-eje-x" x={x0 + banda / 2} y={alto - 6} textAnchor="middle">
                  {categoria.etiqueta}
                </text>
              )}
              <rect
                className="pn-zona"
                x={x0}
                y={MARGEN_SUP}
                width={banda}
                height={plotH}
                fill="transparent"
                onPointerEnter={() => setActiva(c)}
                onPointerDown={() => setActiva(c)}
              />
            </g>
          );
        })}
      </svg>
    </MarcoGrafico>
  );
}

// ---------------------------------------------------------------------------
// LineaArea
// ---------------------------------------------------------------------------

export function LineaArea({
  puntos,
  series,
  previa,
  formato = redondear,
  ariaLabel,
  alto = 180,
}: {
  /** Un elemento por punto del eje X; `valores` alineados con `series`. */
  puntos: { etiqueta: string; valores: number[] }[];
  series: SerieGrafico[];
  /** La serie del período anterior, punteada, alineada por índice con `puntos`. */
  previa?: { nombre: string; valores: number[] };
  formato?: (n: number) => string;
  ariaLabel: string;
  alto?: number;
}) {
  const { activa, setActiva, alTeclear, soltar } = useCursor(puntos.length);
  const { ref: lienzoRef, ancho } = useAnchoMedido();

  const n = puntos.length;

  const valorDe = (punto: { valores: number[] }, i: number) => punto.valores[i] ?? 0;
  const maximo = Math.max(
    0,
    ...puntos.flatMap((p) => series.map((_s, i) => valorDe(p, i))),
    ...(previa ? previa.valores : [])
  );
  const pico = picoBonito(maximo);
  const { izq, der } = margenesDe(pico, formato, puntos.map((p) => p.etiqueta), true);
  const plotW = ancho - izq - der;
  const plotH = alto - MARGEN_SUP - MARGEN_INF;

  const xDe = (i: number) => (n <= 1 ? izq + plotW / 2 : izq + (i / (n - 1)) * plotW);
  const yDe = (v: number) => MARGEN_SUP + plotH - (Math.max(0, v) / pico) * plotH;
  const trazo = (valores: number[]) =>
    valores.map((v, i) => `${i === 0 ? "M" : "L"}${xDe(i).toFixed(1)} ${yDe(v).toFixed(1)}`).join(" ");
  const base = MARGEN_SUP + plotH;
  // Los rótulos van centrados en cada punto: entre dos consecutivos hay `plotW / (n - 1)` px.
  const pasoEtiqueta = pasoDeEtiquetas(
    n <= 1 ? plotW : plotW / (n - 1),
    Math.max(0, ...puntos.map((p) => anchoDeEtiqueta(p.etiqueta)))
  );

  function elegirPorPuntero(evento: PointerEvent<SVGRectElement>) {
    const caja = evento.currentTarget.getBoundingClientRect();
    if (caja.width <= 0 || n === 0) return;
    const fraccion = Math.min(1, Math.max(0, (evento.clientX - caja.left) / caja.width));
    setActiva(n <= 1 ? 0 : Math.round(fraccion * (n - 1)));
  }

  let lectura: Lectura | null = null;
  if (activa !== null && puntos[activa]) {
    const punto = puntos[activa];
    const lineas: LineaDeLectura[] = series.map((s, i) => ({
      id: s.id,
      nombre: s.nombre,
      color: s.color,
      texto: formato(valorDe(punto, i)),
    }));
    if (previa) lineas.push({ id: "previa", nombre: previa.nombre, color: null, texto: formato(previa.valores[activa] ?? 0) });
    lectura = { titulo: punto.etiqueta, lineas };
  }
  const posicion = activa === null ? 50 : (xDe(activa) / ancho) * 100;

  return (
    <MarcoGrafico ariaLabel={ariaLabel} lectura={lectura} posicion={posicion} onKeyDown={alTeclear} onSoltar={soltar} lienzoRef={lienzoRef}>
      <svg className="pn-svg" viewBox={`0 0 ${ancho} ${alto}`} aria-hidden="true">
        <Rejilla pico={pico} izq={izq} plotW={plotW} plotH={plotH} formato={formato} />
        {puntos.map((punto, i) =>
          i % pasoEtiqueta === 0 ? (
            <text key={`${punto.etiqueta}-${i}`} className="pn-eje-x" x={xDe(i)} y={alto - 6} textAnchor="middle">
              {punto.etiqueta}
            </text>
          ) : null
        )}

        {n > 0 &&
          series.length === 1 &&
          (() => {
            const valores = puntos.map((p) => valorDe(p, 0));
            return (
              <path
                className="pn-area"
                d={`${trazo(valores)} L${xDe(n - 1).toFixed(1)} ${base} L${xDe(0).toFixed(1)} ${base} Z`}
                fill={series[0].color}
              />
            );
          })()}

        {previa && n > 0 && (
          <path
            className="pn-linea--previa"
            d={trazo(previa.valores)}
            fill="none"
            stroke="var(--pn-previa)"
            strokeWidth={2}
            strokeDasharray="5 5"
            strokeLinecap="round"
          />
        )}

        {n > 0 &&
          series.map((serie, s) => (
            <path
              key={serie.id}
              className="pn-linea"
              d={trazo(puntos.map((p) => valorDe(p, s)))}
              fill="none"
              stroke={serie.color}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

        {activa !== null && puntos[activa] && (
          <g aria-hidden="true">
            <line className="pn-cursor" x1={xDe(activa)} x2={xDe(activa)} y1={MARGEN_SUP} y2={base} />
            {series.map((serie, s) => (
              <circle key={serie.id} className="pn-punto" cx={xDe(activa)} cy={yDe(valorDe(puntos[activa], s))} r={4} fill={serie.color} />
            ))}
          </g>
        )}

        <rect
          className="pn-zona-cursor"
          x={izq}
          y={MARGEN_SUP}
          width={plotW}
          height={plotH}
          fill="transparent"
          onPointerEnter={elegirPorPuntero}
          onPointerMove={elegirPorPuntero}
          onPointerDown={elegirPorPuntero}
        />
      </svg>
    </MarcoGrafico>
  );
}

// ---------------------------------------------------------------------------
// Anillo
// ---------------------------------------------------------------------------

/**
 * Anillo de avance. `porcentaje` puede pasar de 100 (la cifra dice lo real, el
 * arco se llena y no más) y `null` es "no se puede calcular": pinta «—» y NO
 * traza arco, para que una meta sin definir no parezca un 0 %.
 */
export function Anillo({
  porcentaje,
  color = "var(--pn-bien)",
  ariaLabel,
  tam = 96,
}: {
  porcentaje: number | null;
  color?: string;
  ariaLabel: string;
  tam?: number;
}) {
  const grosor = 10;
  const r = (tam - grosor) / 2;
  const circunferencia = 2 * Math.PI * r;
  const centro = tam / 2;
  const fraccion = porcentaje === null ? 0 : Math.min(1, Math.max(0, porcentaje / 100));

  return (
    <svg className="pn-anillo" viewBox={`0 0 ${tam} ${tam}`} width={tam} height={tam} role="img" aria-label={ariaLabel}>
      <circle className="pn-anillo__pista" cx={centro} cy={centro} r={r} fill="none" strokeWidth={grosor} />
      {porcentaje !== null && (
        <circle
          className="pn-anillo__arco"
          cx={centro}
          cy={centro}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={grosor}
          strokeLinecap="round"
          strokeDasharray={`${circunferencia * fraccion} ${circunferencia}`}
          transform={`rotate(-90 ${centro} ${centro})`}
        />
      )}
      <text className="pn-anillo__cifra lm-num" x={centro} y={centro} textAnchor="middle" dominantBaseline="central">
        {porcentaje === null ? "—" : `${Math.round(porcentaje)} %`}
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// BarraApilada100
// ---------------------------------------------------------------------------

export function BarraApilada100({
  segmentos,
  ariaLabel,
}: {
  segmentos: { id: string; etiqueta: string; valor: number; color: string }[];
  ariaLabel: string;
}) {
  const total = segmentos.reduce((suma, s) => suma + Math.max(0, s.valor), 0);

  return (
    <div className="pn-apilada-wrap">
      <div className="pn-apilada" role="img" aria-label={ariaLabel}>
        {total > 0 &&
          segmentos
            .filter((s) => s.valor > 0)
            .map((s) => (
              <span
                key={s.id}
                className="pn-apilada__seg"
                style={{ width: `${(s.valor * 100) / total}%`, background: s.color }}
              />
            ))}
      </div>
      {total === 0 && <p className="pn-vacio">Sin datos en este período.</p>}
      <ul className="pn-leyenda">
        {segmentos.map((s) => (
          <li key={s.id} className="pn-leyenda__item">
            <span className="pn-leyenda__sw" style={{ background: s.color }} aria-hidden="true" />
            <span>{s.etiqueta}</span>
            <b className="lm-num">{s.valor}</b>
            {total > 0 && <small className="lm-num">{Math.round((s.valor * 100) / total)} %</small>}
          </li>
        ))}
      </ul>
    </div>
  );
}
