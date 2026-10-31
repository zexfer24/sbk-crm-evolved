"use client";

import { useRef, useState, type ChangeEvent } from "react";
import {
  CircleAlert,
  CircleCheck,
  EyeOff,
  ImagePlus,
  RefreshCw,
  Sparkles,
  Star,
  Trash2,
  TriangleAlert,
  Upload,
  Camera,
} from "lucide-react";
import { Drawer, toast } from "@heroui/react";
import type { Product, ProductPhoto } from "@/lib/types";
import { configErrorMessage } from "@/lib/config-write";
import {
  casheaReadiness,
  formatWeightInput,
  isNewFromSaint,
  MOTIVO_SIN_ESTANDAR,
  aiVisibility,
  precioDivisaDisplay,
  priceDisplay,
  sinPeso,
  standardPriceDisplay,
  stockLevel,
  TEXTO_SIN_PRECIO_SAINT,
} from "@/lib/inventory";
import { PRODUCT_PHOTO_INPUT_TYPES } from "@/lib/product-photo-image";
import {
  deleteProductPhoto,
  replaceProductPhoto,
  setPrimaryProductPhoto,
  uploadProductPhoto,
} from "@/lib/product-photo-mutations";
import { createClient } from "@/lib/supabase/client";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CasheaCalculadora } from "@/components/inventario/cashea-calculadora";
import { CasheaLogo } from "@/components/inventario/cashea-logo";
import { CarritoMasIcon } from "@/components/inventario/iconos";
import { useInventarioCarrito } from "@/components/inventario/inventario-carrito-context";
import "@/components/agent-control/agent-control.css";
import "@/components/inventario/producto-ficha.css";

/** Tope de fotos por repuesto; lo hace cumplir el trigger de la base, acá solo se esconde la casilla. */
const MAX_FOTOS = 6;

const TEXTO_STOCK: Record<ReturnType<typeof stockLevel>, string> = {
  agotado: "Agotado",
  bajo: "Bajo stock",
  disponible: "Disponible",
};

const AYUDA_FOTOS =
  "Hasta 6 fotos. JPG, PNG o WebP de hasta 15 MB; se guardan en JPG de 1600 px como máximo. La principal es la que se ve en la lista y la que se envía al chat.";

/**
 * Ficha lateral de un repuesto (30/10/2026, plan «Cada repuesto con su foto»,
 * T4; referencia: `mockups/inventario-fotos`, función `ficha()`).
 *
 * Se abre desde la foto o el nombre de una fila/tarjeta y junta en un panel la
 * galería, los datos de Saint, «Para Cashea» y las dos acciones de venta
 * (carrito y calculadora Cashea). Los helpers de precio son EXACTAMENTE los de
 * `ProductoFila`/`ProductoTarjeta`: una ficha que calculara distinto mostraría
 * tres precios para el mismo repuesto.
 *
 * Quién gestiona las fotos (D1): solo supervisor y admin; la vista lo decide
 * y pasa `puedeEditarFotos`. La RLS de `product_photos` es la barrera real, la
 * interfaz solo evita ofrecer botones que la base rechazaría. NO hay «Enviar
 * foto al chat» (D3): el mockup lo traía y se descartó — la foto se manda
 * desde el chat, no desde Inventario.
 *
 * `onCambio` avisa al padre que algo se guardó para que vuelva a pedir la
 * lista (`router.refresh()`); este panel no guarda copia de las fotos: pinta
 * lo que trae `product` y la selección se guarda por ID, así que al refrescar
 * (o al borrar la foto mirada) cae sola en la principal.
 */
export function ProductoFicha({
  product,
  bcvRate,
  soloLectura = false,
  puedeEditarFotos = false,
  isOpen,
  onOpenChange,
  onCambio,
}: {
  product: Product | null;
  bcvRate: number;
  /** La caja: no ve el precio estándar (mismo criterio que la fila, 14/10/2026). */
  soloLectura?: boolean;
  /** Supervisor y admin (D1). */
  puedeEditarFotos?: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onCambio: () => void;
}) {
  // `null` fuera del provider (tests y pantallas viejas): sin carrito no hay botón.
  const carrito = useInventarioCarrito();
  const [seleccionadaId, setSeleccionadaId] = useState<string | null>(null);
  const [productoPrevio, setProductoPrevio] = useState<string | null>(product?.id ?? null);
  const [ocupado, setOcupado] = useState(false);
  const [confirmandoEliminar, setConfirmandoEliminar] = useState(false);
  const [casheaAbierta, setCasheaAbierta] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Un solo input para «Agregar» y «Reemplazar»: esto recuerda para cuál se abrió el selector.
  const accionPendiente = useRef<"agregar" | "reemplazar">("agregar");

  // "Ajustar el estado cuando cambia un prop" (docs de React): al abrir OTRO
  // repuesto la selección vuelve a la principal. Se hace durante el render y no
  // en un efecto (`react-hooks/set-state-in-effect`).
  const idActual = product?.id ?? null;
  if (idActual !== productoPrevio) {
    setProductoPrevio(idActual);
    setSeleccionadaId(null);
  }

  if (!product) return null;

  const fotos = product.fotos;
  // La selección se guarda por id: si ya no existe (la borraron) o no hay
  // ninguna elegida, se mira la principal, que es la primera.
  const seleccionada: ProductPhoto | null = fotos.find((f) => f.id === seleccionadaId) ?? fotos[0] ?? null;
  const indice = seleccionada ? fotos.indexOf(seleccionada) : -1;

  const nivel = stockLevel(product);
  const promocion = priceDisplay(product, bcvRate);
  const estandar = standardPriceDisplay(product, bcvRate);
  const divisa = precioDivisaDisplay(product);
  const visibilidad = aiVisibility(product);
  const nuevoDesdeSaint = isNewFromSaint(product);
  const cashea = casheaReadiness(product);
  const sinFotos = fotos.length === 0;

  const criteriosCashea: { texto: string; ok: boolean }[] = [
    { texto: "Foto principal", ok: !sinFotos },
    { texto: "Peso cargado", ok: !sinPeso(product.weightKg) },
    { texto: "Precio divisa en SAINT", ok: divisa.estado === "ok" },
    { texto: "Activo en Saint", ok: product.isActive },
  ];

  /**
   * Corre una mutación de fotos con el mismo manejo para todas: bloquea los
   * botones mientras dura (un clic = una acción), avisa y pide al padre que
   * refresque. Devuelve `false` si falló para que el diálogo de eliminar
   * sepa quedarse abierto.
   */
  async function ejecutar(operacion: () => Promise<unknown>, exito: string): Promise<boolean> {
    setOcupado(true);
    try {
      await operacion();
      toast.success(exito);
      onCambio();
      return true;
    } catch (err) {
      toast.danger(configErrorMessage(err, "No se pudo guardar la foto."));
      return false;
    } finally {
      setOcupado(false);
    }
  }

  function abrirSelector(accion: "agregar" | "reemplazar") {
    accionPendiente.current = accion;
    inputRef.current?.click();
  }

  async function alElegirArchivo(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Se vacía para que elegir el MISMO archivo otra vez (tras un error) vuelva a disparar el cambio.
    e.target.value = "";
    if (!file || !product) return;
    const supabase = createClient();
    if (accionPendiente.current === "reemplazar" && seleccionada) {
      await ejecutar(() => replaceProductPhoto(supabase, seleccionada, product.id, file), "Foto reemplazada");
    } else {
      await ejecutar(() => uploadProductPhoto(supabase, product.id, file), "Foto agregada");
    }
  }

  async function marcarPrincipal() {
    if (!seleccionada) return;
    const supabase = createClient();
    await ejecutar(() => setPrimaryProductPhoto(supabase, seleccionada.id), "Foto principal actualizada");
  }

  async function eliminar() {
    if (!seleccionada) return;
    const supabase = createClient();
    const ok = await ejecutar(() => deleteProductPhoto(supabase, seleccionada.id), "Foto eliminada");
    // ConfirmDialog se queda abierto si la acción lanza; el toast ya salió en `ejecutar`.
    if (!ok) throw new Error("No se pudo eliminar la foto");
  }

  return (
    <>
      <Drawer.Root isOpen={isOpen} onOpenChange={onOpenChange}>
        <Drawer.Backdrop>
          <Drawer.Content placement="right">
            <Drawer.Dialog className="inv-ficha" aria-label={`Ficha de ${product.name}`}>
              <Drawer.Header className="ficha-cabecera">
                <div className="ficha-titulo">
                  <Drawer.Heading className="ficha-nombre">{product.name}</Drawer.Heading>
                  <p className="ficha-subtitulo">
                    {product.saintCode ? (
                      <span className="lm-num" aria-label={`Código ${product.saintCode}`}>
                        {product.saintCode}
                      </span>
                    ) : (
                      <span data-empty="true">Sin código</span>
                    )}
                    {product.brand && <span className="ficha-marca">{product.brand}</span>}
                    {!visibilidad.visible && (
                      <span className="ac-badge" data-tone="muted" title={visibilidad.warning ?? undefined}>
                        <EyeOff size={11} aria-hidden="true" />
                        Oculto a la IA
                      </span>
                    )}
                    {sinPeso(product.weightKg) && (
                      <span className="ac-badge" data-tone="wait">
                        <TriangleAlert size={11} aria-hidden="true" />
                        Sin peso
                      </span>
                    )}
                    {nuevoDesdeSaint && (
                      <span className="ac-badge" data-tone="link">
                        <Sparkles size={11} aria-hidden="true" />
                        Nuevo desde Saint
                      </span>
                    )}
                  </p>
                </div>
                <Drawer.CloseTrigger aria-label="Cerrar" />
              </Drawer.Header>

              <Drawer.Body className="ficha-cuerpo">
                <section className="ficha-seccion" aria-label="Fotos">
                  {puedeEditarFotos && (
                    <input
                      ref={inputRef}
                      type="file"
                      hidden
                      accept={PRODUCT_PHOTO_INPUT_TYPES.join(",")}
                      aria-label="Elegir foto"
                      onChange={alElegirArchivo}
                    />
                  )}

                  {seleccionada ? (
                    <>
                      <div className="galeria-principal">
                        {/* eslint-disable-next-line @next/next/no-img-element -- URL pública de Storage ya dimensionada; no pasa por el optimizador de Next */}
                        <img src={seleccionada.url} alt={product.name} />
                        {seleccionada.isPrimary && (
                          <span className="ac-badge" data-tone="link">
                            <Star size={11} aria-hidden="true" />
                            Principal
                          </span>
                        )}
                        {puedeEditarFotos && (
                          <div className="galeria-herr">
                            {!seleccionada.isPrimary && (
                              <button type="button" disabled={ocupado} onClick={marcarPrincipal}>
                                <Star size={13} aria-hidden="true" />
                                Marcar como principal
                              </button>
                            )}
                            <button type="button" disabled={ocupado} onClick={() => abrirSelector("reemplazar")}>
                              <RefreshCw size={13} aria-hidden="true" />
                              Reemplazar
                            </button>
                            <button
                              type="button"
                              data-variant="danger"
                              disabled={ocupado}
                              onClick={() => setConfirmandoEliminar(true)}
                            >
                              <Trash2 size={13} aria-hidden="true" />
                              Eliminar
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="galeria-tira">
                        {fotos.map((foto, i) => (
                          <button
                            key={foto.id}
                            type="button"
                            aria-label={`Foto ${i + 1}`}
                            aria-current={i === indice}
                            onClick={() => setSeleccionadaId(foto.id)}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element -- ver arriba */}
                            <img src={foto.url} alt="" loading="lazy" />
                            {foto.isPrimary && (
                              <span className="estrella" aria-hidden="true">
                                <Star size={11} />
                              </span>
                            )}
                          </button>
                        ))}
                        {puedeEditarFotos && fotos.length < MAX_FOTOS && (
                          <button
                            type="button"
                            className="agregar"
                            aria-label="Agregar otra foto"
                            disabled={ocupado}
                            onClick={() => abrirSelector("agregar")}
                          >
                            <ImagePlus size={20} aria-hidden="true" />
                          </button>
                        )}
                      </div>

                      {puedeEditarFotos && <p className="ficha-hint">{AYUDA_FOTOS}</p>}
                    </>
                  ) : puedeEditarFotos ? (
                    <button
                      type="button"
                      className="dropzone"
                      disabled={ocupado}
                      onClick={() => abrirSelector("agregar")}
                    >
                      <Upload size={30} aria-hidden="true" />
                      <strong>Agregar la primera foto</strong>
                      <span>Haz clic para elegirla. JPG, PNG o WebP de hasta 15 MB.</span>
                    </button>
                  ) : (
                    <div className="dropzone" data-solo-lectura="true">
                      <Camera size={30} aria-hidden="true" />
                      <strong>Este repuesto todavía no tiene foto</strong>
                      <span>Un supervisor puede cargarla desde aquí.</span>
                    </div>
                  )}
                </section>

                <section className="ficha-seccion">
                  <h3 className="lm-eyebrow">Datos de Saint</h3>
                  <div className="ficha-datos">
                    <div className="ficha-dato">
                      <span className="lm-eyebrow">Stock</span>
                      <span className="ficha-stock" data-level={nivel} aria-label={`Stock de ${product.name}`}>
                        {product.stockQuantity}
                      </span>
                      <small>{TEXTO_STOCK[nivel]}</small>
                    </div>

                    <div className="ficha-dato">
                      <span className="lm-eyebrow">Precio promoción</span>
                      <strong className="lm-num">{promocion.principal}</strong>
                      {promocion.pie !== null && <small className="lm-num">{promocion.pie}</small>}
                    </div>

                    <div className="ficha-dato">
                      <span className="lm-eyebrow">Precio divisa</span>
                      {divisa.estado === "ok" ? (
                        <>
                          <strong className="lm-num">{divisa.principal}</strong>
                          <small>De SAINT</small>
                        </>
                      ) : (
                        <>
                          <strong className="lm-num">—</strong>
                          <small>{TEXTO_SIN_PRECIO_SAINT}</small>
                        </>
                      )}
                    </div>

                    {!soloLectura && (
                      <div className="ficha-dato">
                        <span className="lm-eyebrow">Precio estándar</span>
                        {estandar.estado === "ok" ? (
                          <>
                            <strong className="lm-num">{estandar.principal}</strong>
                            <small>
                              {estandar.pie !== null ? `${estandar.pie} · ` : ""}incluye envío {estandar.tarifa}
                            </small>
                          </>
                        ) : (
                          <>
                            <strong className="lm-num">—</strong>
                            <small>{estandar.estado === "sin_peso" ? "Falta el peso" : MOTIVO_SIN_ESTANDAR[estandar.estado]}</small>
                          </>
                        )}
                      </div>
                    )}

                    <div className="ficha-dato">
                      <span className="lm-eyebrow">Peso</span>
                      {sinPeso(product.weightKg) ? (
                        <>
                          <strong className="lm-num">—</strong>
                          <small>Sin cargar</small>
                        </>
                      ) : (
                        <>
                          <strong className="lm-num">{formatWeightInput(product.weightKg)} kg</strong>
                          <small>Cargado a mano</small>
                        </>
                      )}
                    </div>
                  </div>
                </section>

                <section className="cashea-check" aria-label="Para Cashea">
                  <div className="cashea-check-head">
                    <strong>Para Cashea</strong>
                    {cashea.listo ? (
                      <span className="ac-badge" data-tone="good">
                        <CircleCheck size={11} aria-hidden="true" />
                        Listo para Cashea
                      </span>
                    ) : (
                      <span className="ac-badge" data-tone="wait">
                        Le falta: {cashea.faltan.map((t) => t.toLowerCase()).join(", ")}
                      </span>
                    )}
                  </div>
                  <ul>
                    {criteriosCashea.map((c) => (
                      <li key={c.texto} data-ok={c.ok}>
                        {c.ok ? <CircleCheck size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}
                        {c.texto}
                      </li>
                    ))}
                  </ul>
                  <p className="ficha-hint">
                    La sincronización con Cashea todavía no existe: esto solo muestra qué le faltaría a este repuesto el día que exista.
                  </p>
                </section>
              </Drawer.Body>

              <Drawer.Footer className="ficha-pie">
                {carrito && (
                  <button
                    type="button"
                    className="crm-pill"
                    disabled={!product.isActive}
                    title={product.isActive ? undefined : "Saint lo dio de baja"}
                    onClick={() => carrito.agregar(product)}
                  >
                    <CarritoMasIcon size={16} />
                    Agregar al carrito
                  </button>
                )}
                <button type="button" className="crm-pill" onClick={() => setCasheaAbierta(true)}>
                  <CasheaLogo size={18} />
                  Cashea
                </button>
              </Drawer.Footer>
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      </Drawer.Root>

      <ConfirmDialog
        isOpen={confirmandoEliminar}
        onOpenChange={setConfirmandoEliminar}
        titulo="¿Eliminar esta foto?"
        descripcion="El repuesto deja de mostrarla. Los mensajes que ya se enviaron con ella no cambian."
        confirmarEtiqueta="Sí, eliminar"
        peligro
        onConfirmar={eliminar}
      />
      <CasheaCalculadora product={product} bcvRate={bcvRate} isOpen={casheaAbierta} onOpenChange={setCasheaAbierta} />
    </>
  );
}
