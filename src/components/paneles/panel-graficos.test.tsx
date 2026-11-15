/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Anillo, BarraApilada100, BarrasVerticales, LineaArea, Sparkline, type SerieGrafico } from "./panel-graficos";

/**
 * Plan "Paneles" (13/11/2026): primitivas SVG de los tres paneles. jsdom no
 * calcula layout, así que estos tests miran lo que sí es contrato: cada
 * gráfico es un `role="img"` con su resumen en texto, la lectura exacta
 * (tooltip) sale por puntero, toque y flechas, y la geometría respeta los
 * datos (alturas apiladas, arco del anillo, anchos que suman 100 %).
 */

const ONLINE: SerieGrafico = { id: "online", nombre: "Online", color: "var(--pn-online)" };
const TIENDA: SerieGrafico = { id: "tienda", nombre: "Tienda", color: "var(--pn-tienda)" };
const usd = (n: number) => `$${n.toFixed(0)}`;

describe("Sparkline", () => {
  it("es una imagen con su resumen y traza un punto por valor", () => {
    const { container } = render(<Sparkline valores={[1, 3, 2, 5]} ariaLabel="Ventas de los últimos 4 días: de 1 a 5" />);

    expect(screen.getByRole("img", { name: /últimos 4 días/ })).toBeInTheDocument();
    const puntos = container.querySelector("polyline")?.getAttribute("points")?.trim().split(/\s+/);
    expect(puntos).toHaveLength(4);
  });

  it("con un solo valor o ninguno no revienta (línea plana)", () => {
    const { container, rerender } = render(<Sparkline valores={[7]} ariaLabel="Un día" />);
    expect(container.querySelector("svg")).toBeTruthy();
    rerender(<Sparkline valores={[]} ariaLabel="Sin datos" />);
    expect(container.querySelector("svg")).toBeTruthy();
  });
});

describe("BarrasVerticales", () => {
  const categorias = [
    { etiqueta: "Lun", valores: [100, 50] },
    { etiqueta: "Mar", valores: [0, 200] },
    { etiqueta: "Mié", valores: [300, 0] },
  ];

  it("es una imagen con el resumen que le pasan", () => {
    render(<BarrasVerticales categorias={categorias} series={[ONLINE, TIENDA]} ariaLabel="Ventas por día: mejor el miércoles" />);
    expect(screen.getByRole("img", { name: /mejor el miércoles/ })).toBeInTheDocument();
  });

  it("agrupadas: una barra por serie y categoría", () => {
    const { container } = render(<BarrasVerticales categorias={categorias} series={[ONLINE, TIENDA]} ariaLabel="x" />);
    expect(container.querySelectorAll(".pn-barra")).toHaveLength(6);
  });

  it("apiladas: la altura de la barra de arriba empieza donde termina la de abajo", () => {
    const { container } = render(
      <BarrasVerticales categorias={[{ etiqueta: "Lun", valores: [100, 50] }]} series={[ONLINE, TIENDA]} apiladas ariaLabel="x" />
    );

    const [abajo, arriba] = Array.from(container.querySelectorAll<SVGRectElement>(".pn-barra"));
    const yAbajo = Number(abajo.getAttribute("y"));
    const hAbajo = Number(abajo.getAttribute("height"));
    const yArriba = Number(arriba.getAttribute("y"));
    const hArriba = Number(arriba.getAttribute("height"));
    expect(hAbajo).toBeGreaterThan(hArriba);
    expect(yArriba + hArriba).toBeCloseTo(yAbajo, 1);
  });

  it("un valor 0 no deja una barra visible", () => {
    const { container } = render(<BarrasVerticales categorias={[{ etiqueta: "Lun", valores: [0, 80] }]} series={[ONLINE, TIENDA]} ariaLabel="x" />);
    const alturas = Array.from(container.querySelectorAll<SVGRectElement>(".pn-barra")).map((r) => Number(r.getAttribute("height")));
    expect(alturas[0]).toBe(0);
    expect(alturas[1]).toBeGreaterThan(0);
  });

  it("el puntero sobre una categoría muestra la lectura exacta y al salir se oculta", () => {
    const { container } = render(<BarrasVerticales categorias={categorias} series={[ONLINE, TIENDA]} formato={usd} ariaLabel="x" />);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.pointerEnter(container.querySelectorAll(".pn-zona")[1]);

    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("Mar");
    expect(tip).toHaveTextContent("Tienda");
    expect(tip).toHaveTextContent("$200");

    fireEvent.pointerLeave(container.querySelector(".pn-graf")!);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("apiladas: la lectura trae el total", () => {
    const { container } = render(<BarrasVerticales categorias={categorias} series={[ONLINE, TIENDA]} apiladas formato={usd} ariaLabel="x" />);

    fireEvent.pointerEnter(container.querySelectorAll(".pn-zona")[0]);

    expect(screen.getByRole("tooltip")).toHaveTextContent(/Total.*\$150/);
  });

  it("las flechas recorren las categorías y Esc suelta la lectura", () => {
    render(<BarrasVerticales categorias={categorias} series={[ONLINE, TIENDA]} formato={usd} ariaLabel="x" />);
    const grafico = screen.getByRole("img");

    fireEvent.keyDown(grafico, { key: "ArrowRight" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Lun");
    fireEvent.keyDown(grafico, { key: "ArrowRight" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Mar");
    fireEvent.keyDown(grafico, { key: "End" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Mié");
    fireEvent.keyDown(grafico, { key: "ArrowRight" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Mié");
    fireEvent.keyDown(grafico, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("la lectura también se anuncia en una región viva para lectores de pantalla", () => {
    const { container } = render(<BarrasVerticales categorias={categorias} series={[ONLINE, TIENDA]} formato={usd} ariaLabel="x" />);

    fireEvent.pointerEnter(container.querySelectorAll(".pn-zona")[2]);

    expect(container.querySelector("[aria-live='polite']")).toHaveTextContent(/Mié.*Online.*\$300/);
  });

  it("sin datos no revienta", () => {
    const { container } = render(<BarrasVerticales categorias={[]} series={[ONLINE]} ariaLabel="Sin ventas" />);
    expect(container.querySelector("svg")).toBeTruthy();
  });
});

describe("LineaArea", () => {
  const puntos = [
    { etiqueta: "08:00", valores: [10, 5] },
    { etiqueta: "09:00", valores: [30, 25] },
    { etiqueta: "10:00", valores: [60, 40] },
  ];

  it("traza una línea por serie y la previa punteada", () => {
    const { container } = render(
      <LineaArea puntos={puntos} series={[ONLINE, TIENDA]} previa={{ nombre: "Semana pasada", valores: [8, 20, 50] }} ariaLabel="Acumulado del día" />
    );

    expect(container.querySelectorAll(".pn-linea")).toHaveLength(2);
    const previa = container.querySelector(".pn-linea--previa");
    expect(previa).toBeTruthy();
    expect(previa?.getAttribute("stroke-dasharray")).toBeTruthy();
  });

  it("una sola serie con área rellena", () => {
    const { container } = render(<LineaArea puntos={puntos.map((p) => ({ ...p, valores: [p.valores[0]] }))} series={[ONLINE]} ariaLabel="x" />);
    expect(container.querySelectorAll(".pn-linea")).toHaveLength(1);
    expect(container.querySelectorAll(".pn-area")).toHaveLength(1);
  });

  it("las flechas mueven el cursor y la lectura trae cada serie y la previa", () => {
    render(
      <LineaArea
        puntos={puntos}
        series={[ONLINE, TIENDA]}
        previa={{ nombre: "Semana pasada", valores: [8, 20, 50] }}
        formato={usd}
        ariaLabel="x"
      />
    );
    const grafico = screen.getByRole("img");

    fireEvent.keyDown(grafico, { key: "ArrowRight" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("08:00");
    fireEvent.keyDown(grafico, { key: "ArrowRight" });

    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("09:00");
    expect(tip).toHaveTextContent("Online");
    expect(tip).toHaveTextContent("$30");
    expect(tip).toHaveTextContent("Tienda");
    expect(tip).toHaveTextContent("$25");
    expect(tip).toHaveTextContent("Semana pasada");
    expect(tip).toHaveTextContent("$20");
  });

  it("el puntero (o el toque) sobre el área elige el punto más cercano", () => {
    const { container } = render(<LineaArea puntos={puntos} series={[ONLINE]} formato={usd} ariaLabel="x" />);
    const zona = container.querySelector(".pn-zona-cursor") as SVGRectElement;
    zona.getBoundingClientRect = () => ({ left: 0, right: 600, top: 0, bottom: 100, width: 600, height: 100, x: 0, y: 0, toJSON: () => ({}) });

    fireEvent.pointerMove(zona, { clientX: 600 });

    expect(screen.getByRole("tooltip")).toHaveTextContent("10:00");
  });

  it("Inicio y Fin saltan a los extremos", () => {
    render(<LineaArea puntos={puntos} series={[ONLINE]} formato={usd} ariaLabel="x" />);
    const grafico = screen.getByRole("img");

    fireEvent.keyDown(grafico, { key: "End" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("10:00");
    fireEvent.keyDown(grafico, { key: "Home" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("08:00");
  });

  it("con un solo punto no divide por cero", () => {
    const { container } = render(<LineaArea puntos={[puntos[0]]} series={[ONLINE]} ariaLabel="x" />);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });
});

describe("Anillo", () => {
  it("pinta el porcentaje redondeado y lo anuncia", () => {
    render(<Anillo porcentaje={64.6} ariaLabel="Avance de la meta: 65 %" />);

    expect(screen.getByRole("img", { name: /Avance de la meta/ })).toBeInTheDocument();
    expect(screen.getByText("65 %")).toBeInTheDocument();
  });

  it("el arco recorre la fracción del círculo", () => {
    const { container } = render(<Anillo porcentaje={25} ariaLabel="x" />);
    const arco = container.querySelector(".pn-anillo__arco") as SVGCircleElement;
    const longitud = Number(arco.getAttribute("stroke-dasharray")?.split(" ")[0]);
    const total = 2 * Math.PI * Number(arco.getAttribute("r"));
    expect(longitud).toBeCloseTo(total * 0.25, 1);
  });

  it("pasar del 100 % llena el anillo pero la cifra dice lo real", () => {
    const { container } = render(<Anillo porcentaje={130} ariaLabel="x" />);
    const arco = container.querySelector(".pn-anillo__arco") as SVGCircleElement;
    const total = 2 * Math.PI * Number(arco.getAttribute("r"));
    expect(Number(arco.getAttribute("stroke-dasharray")?.split(" ")[0])).toBeCloseTo(total, 1);
    expect(screen.getByText("130 %")).toBeInTheDocument();
  });

  it("sin porcentaje (null: no se puede calcular) pinta «—», nunca 0", () => {
    const { container } = render(<Anillo porcentaje={null} ariaLabel="Sin meta" />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("0 %")).toBeNull();
    expect(container.querySelector(".pn-anillo__arco")).toBeNull();
  });
});

describe("BarraApilada100", () => {
  const segmentos = [
    { id: "a", etiqueta: "Compraron", valor: 30, color: "var(--pn-bien)" },
    { id: "b", etiqueta: "Solo preguntaron", valor: 50, color: "var(--pn-online)" },
    { id: "c", etiqueta: "Sin respuesta", valor: 20, color: "var(--pn-critico)" },
  ];

  it("los segmentos miden su fracción y suman 100 %", () => {
    const { container } = render(<BarraApilada100 segmentos={segmentos} ariaLabel="Resultados de las conversaciones" />);

    const anchos = Array.from(container.querySelectorAll<HTMLElement>(".pn-apilada__seg")).map((s) => parseFloat(s.style.width));
    expect(anchos).toEqual([30, 50, 20]);
    expect(anchos.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 5);
    expect(screen.getByRole("img", { name: /Resultados/ })).toBeInTheDocument();
  });

  it("la leyenda nombra cada segmento con su cantidad y porcentaje", () => {
    render(<BarraApilada100 segmentos={segmentos} ariaLabel="x" />);

    const fila = screen.getByText("Solo preguntaron").closest(".pn-leyenda__item") as HTMLElement;
    expect(fila).toHaveTextContent("50");
    expect(fila).toHaveTextContent("50 %");
  });

  it("un segmento en 0 no ocupa ancho pero sigue en la leyenda", () => {
    const { container } = render(<BarraApilada100 segmentos={[...segmentos, { id: "d", etiqueta: "Reclamo", valor: 0, color: "var(--pn-alerta)" }]} ariaLabel="x" />);

    expect(container.querySelectorAll(".pn-apilada__seg")).toHaveLength(3);
    expect(screen.getByText("Reclamo")).toBeInTheDocument();
  });

  it("con total 0 no inventa porcentajes: dice que no hay datos", () => {
    const { container } = render(<BarraApilada100 segmentos={segmentos.map((s) => ({ ...s, valor: 0 }))} ariaLabel="x" />);

    expect(container.innerHTML).not.toMatch(/NaN/);
    expect(screen.getByText(/sin datos/i)).toBeInTheDocument();
  });
});
