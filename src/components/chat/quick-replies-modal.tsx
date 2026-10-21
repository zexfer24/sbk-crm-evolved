"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { flushSync } from "react-dom";
import { ImagePlus, Link2, Pencil, Plus, Trash2, TriangleAlert, X, Zap } from "lucide-react";
import { Button, Input, Label, Modal, TextArea, toast } from "@heroui/react";
import type { CatalogLink, QuickReply } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { fetchMensajesRapidosMasUsados, type MensajeRapidoMasUsado } from "@/lib/data";
import { createQuickReply, deleteQuickReply, updateQuickReply, uploadQuickReplyPhoto } from "@/lib/mutations";
import { QUICK_REPLY_MAX_PHOTOS, validateQuickReplyPhotos } from "@/lib/quick-reply-media";
import { mediaUrlFor } from "@/lib/storage";
import { configErrorMessage } from "@/lib/config-write";
import { catalogMarkerFor, catalogUrlHint, hasRawUrl, resolveCatalogMarkers } from "@/lib/catalog-links";
import { insertAtCaret } from "@/lib/composer-text";
import { SlidingPills } from "@/components/sliding-pills";
import {
  buscarMensajesRapidos,
  coincideMedia,
  normalizarBusqueda,
  resaltar,
  type FiltroMedia,
} from "@/lib/quick-reply-filter";

/** Las dos pestañas de T5b: los compartidos (`ownerId === null`) y los del propio asesor. */
type QuickReplyTab = "shared" | "mine";

function byLabel(a: QuickReply, b: QuickReply) {
  return a.label.localeCompare(b.label, "es");
}

/**
 * El ranking «Más usados» se pide UNA vez por día y por pestaña (T8, plan
 * "Presupuestos y mensajes rápidos", 21/10/2026): la clave es `masUsadosHasta`,
 * la medianoche de Caracas de hoy, que cambia solo cuando cambia el día. El
 * modal vive montado en cada chat y se abre muchas veces; sin esta caché cada
 * apertura sería una consulta a la RPC para un número que no se mueve en todo
 * el día. Se guarda la PROMESA (no el resultado) para que dos aperturas
 * seguidas, antes de que llegue la primera respuesta, compartan la misma
 * consulta. Una promesa fallida sale de la caché: la próxima apertura reintenta
 * en vez de quedarse sin franja hasta recargar la pestaña.
 */
const cacheMasUsados = new Map<string, Promise<MensajeRapidoMasUsado[]>>();

/** Solo para los tests: cada uno parte sin ranking en caché. */
export function __reiniciarCacheMasUsados() {
  cacheMasUsados.clear();
}

function cargarMasUsados(hasta: string): Promise<MensajeRapidoMasUsado[]> {
  const guardada = cacheMasUsados.get(hasta);
  if (guardada) return guardada;
  // `async` para que un fallo SÍNCRONO al armar el cliente también sea un rechazo.
  const promesa = (async () => fetchMensajesRapidosMasUsados(createClient(), hasta))();
  cacheMasUsados.set(hasta, promesa);
  promesa.catch(() => {
    if (cacheMasUsados.get(hasta) === promesa) cacheMasUsados.delete(hasta);
  });
  return promesa;
}

interface QuickRepliesModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  quickReplies: QuickReply[];
  /**
   * El asesor que tiene el modal abierto (T5b, "La ronda del cliente",
   * 30/9/2026): «Mis mensajes» son los que tienen `ownerId === currentAgentId`
   * y un mensaje nuevo con «Solo para mí» nace con este `ownerId`. La RLS ya no
   * entrega los personales de otros, pero el filtro por id también se hace acá:
   * no depende de que la base sea la única barrera.
   */
  currentAgentId: string;
  /**
   * Los catálogos ACTIVOS (T4b, "Nada sin leer, un solo catálogo y la
   * factura Saint", 18/9/2026): alimentan el botón "Insertar catálogo" (una
   * entrada por clave, más "Todos los catálogos") y la marca de "marcador
   * sin resolver" sobre cada mensaje rápido de la lista.
   */
  catalogLinks: CatalogLink[];
  /**
   * Entrega la respuesta ENTERA y no solo su texto (14/10/2026, "Respuestas
   * rápidas con fotos"): el composer necesita `mediaPaths` para sumar las
   * fotos como adjuntos pendientes.
   */
  onSelect: (reply: QuickReply) => void;
  /**
   * Medianoche de Caracas de hoy (T8, 21/10/2026): el string de
   * `useInboxDay("today")`, que baja de `crm-shell.tsx` por `ChatPanel` y
   * `Composer`. Con él se pide la franja «Más usados»; sin él (llamadores
   * anteriores, tests) no se consulta nada ni se pinta la franja. NO se
   * recalcula acá: CLAUDE.md, trampa del corte "habló hoy".
   */
  masUsadosHasta?: string | null;
}

export function QuickRepliesModal({
  isOpen,
  onOpenChange,
  quickReplies,
  currentAgentId,
  catalogLinks,
  onSelect,
  masUsadosHasta,
}: QuickRepliesModalProps) {
  const sharedReplies = quickReplies.filter((reply) => reply.ownerId === null).sort(byLabel);
  const myReplies = quickReplies.filter((reply) => reply.ownerId === currentAgentId).sort(byLabel);

  // 21/10/2026, "Presupuestos y mensajes rápidos" (T7): buscador por palabra
  // clave, filtro Todos / Solo texto / Con fotos y confirmación de borrado
  // dentro del renglón. Los tres se reinician al cerrar el modal (abajo).
  const [query, setQuery] = useState("");
  const [mediaFilter, setMediaFilter] = useState<FiltroMedia>("todos");
  const [confirmandoBorrarId, setConfirmandoBorrarId] = useState<string | null>(null);
  const [borrandoId, setBorrandoId] = useState<string | null>(null);

  // «Más usados» (T8, 21/10/2026): se guarda junto con el `hasta` al que
  // pertenece para no pintar el ranking de ayer mientras llega el de hoy. Efecto
  // inline con `.then()` y bandera `cancelado`: un `setState` dentro de un
  // `useCallback` llamado desde el efecto dispara `react-hooks/set-state-in-effect`
  // aunque viva tras un `await` (CLAUDE.md, trampa de T4 del 22/9/2026).
  const [masUsados, setMasUsados] = useState<{ hasta: string; items: MensajeRapidoMasUsado[] } | null>(null);
  useEffect(() => {
    if (!isOpen || !masUsadosHasta) return;
    let cancelado = false;
    cargarMasUsados(masUsadosHasta)
      .then((items) => {
        if (!cancelado) setMasUsados({ hasta: masUsadosHasta, items });
      })
      .catch((error) => {
        // Sin toast: la franja es un atajo, no una dependencia del modal.
        console.error("mensajes_rapidos_mas_usados", error);
      });
    return () => {
      cancelado = true;
    };
  }, [isOpen, masUsadosHasta]);

  // Solo los que ESTE asesor ve (la RPC ya filtra, pero la lista que tiene el
  // modal es la que manda), en el orden del ranking.
  const masUsadosVisibles =
    masUsados && masUsados.hasta === masUsadosHasta
      ? masUsados.items.flatMap((item) => {
          const reply = quickReplies.find((candidate) => candidate.id === item.quickReplyId);
          return reply ? [{ reply, usos: item.usos }] : [];
        })
      : [];

  // Pestaña inicial: «Mis mensajes» si el asesor ya tiene alguno, porque es
  // donde va a buscar sus saludos; si no, «Compartidos». Se recalcula cada vez
  // que el modal se ABRE (patrón "Adjusting state when a prop changes" de
  // React, durante el render): el componente vive montado aunque esté cerrado
  // y los mensajes pueden llegar después del primer render.
  const [tab, setTab] = useState<QuickReplyTab>(myReplies.length > 0 ? "mine" : "shared");
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setTab(myReplies.length > 0 ? "mine" : "shared");
    else {
      setQuery("");
      setMediaFilter("todos");
      setConfirmandoBorrarId(null);
    }
  }
  const tabReplies = tab === "mine" ? myReplies : sharedReplies;
  // Los conteos del filtro son los de la pestaña activa y NO dependen de la
  // búsqueda: dicen cuántos hay de cada tipo, no cuántos calzaron.
  const mediaCounts = {
    todos: tabReplies.length,
    texto: tabReplies.filter((reply) => coincideMedia(reply, "texto")).length,
    fotos: tabReplies.filter((reply) => coincideMedia(reply, "fotos")).length,
  };
  const { porTitulo, porTexto } = buscarMensajesRapidos(tabReplies, query, mediaFilter);
  const hayConsulta = normalizarBusqueda(query) !== "";
  const hayResultados = porTitulo.length + porTexto.length > 0;

  // «Solo para mí» solo existe al CREAR: un mensaje no cambia de tipo al
  // editarlo (la mutación de update ni siquiera manda `owner_id`).
  const [onlyForMe, setOnlyForMe] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [content, setContent] = useState("");
  // Fotos de la respuesta (14/10/2026): rutas `quick-replies/…` YA subidas. Se
  // suben al elegirlas, no al guardar, para que "Guardar" sea instantáneo y la
  // miniatura salga de la ruta real que quedará en la base.
  const [mediaPaths, setMediaPaths] = useState<string[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  // Cada vez que el formulario se abre, se edita otra respuesta o se cierra,
  // sube la "época": una subida que termina DESPUÉS no debe colar su foto en un
  // formulario que ya no es el suyo.
  const formEpochRef = useRef(0);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isCatalogMenuOpen, setIsCatalogMenuOpen] = useState(false);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  // El menú solo ofrece los catálogos ACTIVOS, en el orden del panel: uno
  // inactivo dejaría el marcador SIN RESOLVER apenas se pegara (D6).
  const activeCatalogLinks = catalogLinks
    .filter((link) => link.isActive)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);

  function startCreate() {
    setEditingId(null);
    setLabel("");
    setContent("");
    setMediaPaths([]);
    formEpochRef.current += 1;
    // Se crea donde el asesor está mirando: desde «Mis mensajes» nace personal.
    setOnlyForMe(tab === "mine");
    setIsFormOpen(true);
    setIsCatalogMenuOpen(false);
  }

  function startEdit(reply: QuickReply) {
    setEditingId(reply.id);
    setLabel(reply.label);
    setContent(reply.content);
    setMediaPaths(reply.mediaPaths);
    formEpochRef.current += 1;
    setIsFormOpen(true);
    setIsCatalogMenuOpen(false);
  }

  /**
   * "Insertar catálogo" (D4, T4b, 18/9/2026): pega el marcador en la
   * posición del cursor, nunca al final -- el supervisor puede estar
   * redactando "Acá va nuestro catálogo: <cursor> ¡Cualquier cosa
   * pregunta!". `flushSync` antes de reposicionar el cursor, mismo motivo
   * que `insertEmoji`/`wrapSelection` en `composer.tsx`: sin el commit
   * forzado, `setSelectionRange` puede perder la carrera contra el commit
   * de React bajo CPU contendida (29/8/2026).
   */
  function insertCatalogMarker(marker: string) {
    const textarea = contentRef.current;
    const start = textarea?.selectionStart ?? content.length;
    const end = textarea?.selectionEnd ?? content.length;
    const { text: nextText, caret } = insertAtCaret(content, start, end, marker);

    flushSync(() => setContent(nextText));

    textarea?.focus();
    textarea?.setSelectionRange(caret, caret);
    setIsCatalogMenuOpen(false);
  }

  // T7 (28/9/2026): una URL de Drive escrita a mano en el mensaje es lo que
  // hizo que los asesores mandaran un link de "CATALOGO CASCOS" distinto al
  // de Seba. Con el formulario abierto se avisa en el momento de escribirla.
  const catalogHint = isFormOpen ? catalogUrlHint(content, label, catalogLinks) : null;

  function replaceUrlWithMarker(url: string, marker: string) {
    setContent((current) => current.split(url).join(marker));
  }

  function closeForm() {
    formEpochRef.current += 1;
    setIsFormOpen(false);
  }

  /**
   * Valida el lote ENTERO antes de subir nada (tipo, peso y tope de 10 contando
   * las que ya lleva y las que están subiendo) y sube en paralelo. Una subida
   * que falla no tira las que sí salieron: esas se quedan, en el orden elegido,
   * y el primer error se avisa.
   */
  async function handlePhotosChosen(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;

    const rejection = validateQuickReplyPhotos(mediaPaths.length + uploadingCount, files);
    if (rejection) {
      toast.danger(rejection);
      return;
    }

    const epoch = formEpochRef.current;
    setUploadingCount((count) => count + files.length);
    const supabase = createClient();
    const results = await Promise.allSettled(files.map((file) => uploadQuickReplyPhoto(supabase, file)));
    setUploadingCount((count) => count - files.length);
    if (epoch !== formEpochRef.current) return;

    const uploaded = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    if (uploaded.length > 0) setMediaPaths((current) => [...current, ...uploaded]);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) {
      toast.danger(failed.reason instanceof Error ? failed.reason.message : "No se pudo subir la foto.");
    }
  }

  function removePhoto(index: number) {
    setMediaPaths((current) => current.filter((_, i) => i !== index));
  }

  async function handleSave() {
    if (!label.trim()) {
      toast.danger("Completa el título.");
      return;
    }
    // Sin fotos el texto sigue siendo obligatorio; con al menos una puede ir
    // vacío (una respuesta de solo fotos).
    if (!content.trim() && mediaPaths.length === 0) {
      toast.danger("Escribe el mensaje o agrega al menos una foto.");
      return;
    }
    setIsSaving(true);
    try {
      const supabase = createClient();
      if (editingId) {
        await updateQuickReply(supabase, editingId, label.trim(), content.trim(), mediaPaths);
      } else {
        await createQuickReply(supabase, label.trim(), content.trim(), onlyForMe ? currentAgentId : null, mediaPaths);
        // Un mensaje recién creado se ve en su pestaña: crear un personal
        // desde «Compartidos» (o al revés) lo dejaría fuera de la vista.
        setTab(onlyForMe ? "mine" : "shared");
      }
      closeForm();
    } catch (error) {
      toast.danger(configErrorMessage(error, "No se pudo guardar el mensaje rápido."));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setBorrandoId(id);
    try {
      const supabase = createClient();
      await deleteQuickReply(supabase, id);
    } catch (error) {
      toast.danger(configErrorMessage(error, "No se pudo borrar el mensaje rápido."));
    } finally {
      // Con éxito o con error la franja se cierra: si falló, el toast ya dijo
      // por qué y el asesor vuelve a armar el borrado si quiere reintentar.
      setBorrandoId(null);
      setConfirmandoBorrarId((actual) => (actual === id ? null : actual));
    }
  }

  /**
   * Pinta un texto con los trozos que calzan con la búsqueda dentro de
   * `<mark>`. Sin consulta devuelve el texto tal cual (un solo nodo de texto).
   */
  function highlighted(text: string) {
    if (!hayConsulta) return text;
    return resaltar(text, query).map((chunk, index) =>
      chunk.marcado ? (
        <mark key={index} className="rounded-sm bg-warning/30 px-0.5 text-inherit">
          {chunk.texto}
        </mark>
      ) : (
        chunk.texto
      )
    );
  }

  function renderRow(reply: QuickReply) {
    // D6: un `{{catalogo:<key>}}` que no calza con ningún
    // catálogo activo se queda TAL CUAL en el texto -- acá se
    // marca en la lista para que el asesor lo vea antes de
    // "Usar", no solo después de pegarlo (el toast de
    // `composer.tsx` avisa recién en ese momento).
    const unresolved = resolveCatalogMarkers(reply.content, catalogLinks).missing;
    // T7 (28/9/2026): el mismo aviso, ya guardado — así el
    // supervisor ve en la lista cuáles llevan un enlace de Drive
    // a mano sin abrir cada uno.
    const handWrittenLink = catalogUrlHint(reply.content, reply.label, catalogLinks);
    const confirmando = confirmandoBorrarId === reply.id;
    const borrando = borrandoId === reply.id;
    return (
      <div
        key={reply.id}
        className="flex flex-col gap-2 rounded-[var(--radius)] border border-border bg-surface p-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-medium">
              <span>{highlighted(reply.label)}</span>
              {reply.mediaPaths.length > 0 && (
                <span
                  className="inline-flex items-center text-xs font-normal text-muted"
                  aria-label={`${reply.mediaPaths.length} ${reply.mediaPaths.length === 1 ? "foto" : "fotos"}`}
                >
                  📷 {reply.mediaPaths.length}
                </span>
              )}
              {unresolved.length > 0 && (
                <span className="inline-flex items-center gap-1 text-xs font-normal text-warning">
                  <TriangleAlert size={11} />
                  Marcador sin resolver
                </span>
              )}
              {handWrittenLink && (
                <span className="inline-flex items-center gap-1 text-xs font-normal text-warning">
                  <TriangleAlert size={11} />
                  Enlace de Drive escrito a mano
                </span>
              )}
            </p>
            <p className="truncate text-xs text-muted">{reply.content || "Solo fotos"}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="ghost" isIconOnly onPress={() => startEdit(reply)} aria-label="Editar">
              <Pencil size={13} />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              isIconOnly
              onPress={() => setConfirmandoBorrarId(reply.id)}
              aria-label="Borrar"
            >
              <Trash2 size={13} />
            </Button>
            <Button size="sm" variant="secondary" onPress={() => onSelect(reply)}>
              Usar
            </Button>
          </div>
        </div>
        {/* 21/10/2026 (T7): la confirmación vive en el renglón y no en otra
            ventana. Este panel ya es un Modal; apilar un segundo en el teléfono
            deja inalcanzable el de atrás. */}
        {confirmando && (
          <div
            role="group"
            aria-label="Confirmar borrado"
            aria-busy={borrando}
            className="flex flex-col gap-2 rounded-[var(--radius)] border border-danger/40 bg-danger/10 p-2 text-sm"
          >
            <p>
              ¿Borrar «{reply.label}»?{" "}
              {reply.ownerId === null ? "Lo dejan de ver todos los asesores." : "Solo lo ves tú."} No se puede
              deshacer.
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onPress={() => setConfirmandoBorrarId(null)} isDisabled={borrando}>
                Cancelar
              </Button>
              <Button
                size="sm"
                variant="danger"
                onPress={() => handleDelete(reply.id)}
                isDisabled={borrando}
              >
                {borrando ? "Borrando…" : "Sí, borrar"}
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop>
        <Modal.Container size="lg" placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Icon>
                <Zap size={18} />
              </Modal.Icon>
              <Modal.Heading>Mensajes rápidos</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-3">
              {/* T8 (21/10/2026): entre el título y las pestañas, sin filtrarse
                  con la búsqueda; se esconde mientras el formulario está abierto. */}
              {!isFormOpen && masUsadosVisibles.length > 0 && (
                <section aria-label="Más usados" className="qr-top">
                  <div className="qr-top-head">
                    <h3 className="qr-top-title">Más usados</h3>
                    <p className="qr-top-note">Actualizado hoy a las 00:00 · últimos 30 días</p>
                  </div>
                  <div className="qr-top-list">
                    {masUsadosVisibles.map(({ reply, usos }) => (
                      <button key={reply.id} type="button" className="qr-top-card" onClick={() => onSelect(reply)}>
                        <span className="qr-top-label">{reply.label}</span>
                        <span className="qr-top-meta">
                          <span className="lm-num">{usos === 1 ? "1 envío" : `${usos} envíos`}</span>
                          {reply.mediaPaths.length > 0 && <span>📷 {reply.mediaPaths.length}</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              <SlidingPills
                tone="segmented"
                variant="tablist"
                ariaLabel="Tipo de mensajes rápidos"
                value={tab}
                onChange={setTab}
                items={[
                  { value: "shared", label: "Compartidos", count: sharedReplies.length },
                  { value: "mine", label: "Mis mensajes", count: myReplies.length },
                ]}
              />

              <Input
                id="quick-replies-search"
                type="search"
                aria-label="Buscar mensajes rápidos"
                placeholder="Buscar por título…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                fullWidth
              />
              <SlidingPills
                tone="segmented"
                variant="group"
                ariaLabel="Tipo de contenido"
                value={mediaFilter}
                onChange={setMediaFilter}
                items={[
                  { value: "todos", label: "Todos", count: mediaCounts.todos },
                  { value: "texto", label: "Solo texto", count: mediaCounts.texto },
                  { value: "fotos", label: "Con fotos", count: mediaCounts.fotos },
                ]}
              />

              {!isFormOpen && (
                <Button variant="secondary" size="sm" onPress={startCreate} className="self-start">
                  <Plus size={14} />
                  Nuevo mensaje rápido
                </Button>
              )}

              {/* T2, "La ronda del cliente" (30/9/2026): los contenedores de este
                  modal usan `--radius` (tarjeta), NUNCA `rounded-field`
                  (`--field-radius: 999px`, solo para inputs). Con 999px este panel
                  de ~246 px de alto se dibujaba como un óvalo gigante al editar:
                  la «píldora» que el cliente veía en el modal. */}
              {isFormOpen && (
                <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-border bg-surface p-3">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="qr-label">Título</Label>
                    <Input id="qr-label" value={label} onChange={(e) => setLabel(e.target.value)} fullWidth />
                  </div>
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="qr-content">Mensaje</Label>
                      <div className="relative">
                        <Button
                          size="sm"
                          variant="ghost"
                          onPress={() => setIsCatalogMenuOpen((open) => !open)}
                          aria-expanded={isCatalogMenuOpen}
                        >
                          <Link2 size={13} />
                          Insertar catálogo
                        </Button>
                        {isCatalogMenuOpen && (
                          <div
                            role="menu"
                            aria-label="Catálogos"
                            className="lm-catalog-menu absolute right-0 z-10 mt-1 flex min-w-40 flex-col gap-0.5 rounded-[var(--radius)] border border-border bg-surface p-1 shadow-md"
                          >
                            <button
                              type="button"
                              role="menuitem"
                              className="lm-catalog-menu-item rounded-[var(--radius)] px-2 py-1 text-left text-sm hover:bg-default"
                              onClick={() => insertCatalogMarker("{{catalogos}}")}
                            >
                              Todos los catálogos
                            </button>
                            {activeCatalogLinks.map((link) => (
                              <button
                                key={link.id}
                                type="button"
                                role="menuitem"
                                className="lm-catalog-menu-item rounded-[var(--radius)] px-2 py-1 text-left text-sm hover:bg-default"
                                onClick={() => insertCatalogMarker(catalogMarkerFor(link.key))}
                              >
                                {link.label}
                              </button>
                            ))}
                            {activeCatalogLinks.length === 0 && (
                              <p className="px-2 py-1 text-xs text-muted">Todavía no hay catálogos cargados.</p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <TextArea
                      id="qr-content"
                      ref={contentRef}
                      value={content}
                      onChange={(e) => setContent(e.target.value)}
                      rows={3}
                      fullWidth
                    />
                    {catalogHint && (
                      <div role="alert" className="flex flex-col gap-1 text-xs text-warning">
                        <p className="flex items-start gap-1">
                          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                          <span>
                            Usá el marcador para que Seba y los asesores manden el mismo link.{" "}
                            {catalogHint.marker
                              ? `Este enlace ya es el catálogo «${catalogHint.catalogLabel}»: el marcador es ${catalogHint.marker}.`
                              : "Este enlace de Drive no coincide con ningún catálogo configurado: cárgalo en Control IA, pestaña Respuestas, y usa su marcador."}
                          </span>
                        </p>
                        {catalogHint.marker && (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="self-start"
                            onPress={() => replaceUrlWithMarker(catalogHint.url, catalogHint.marker as string)}
                          >
                            Reemplazar por {catalogHint.marker}
                          </Button>
                        )}
                      </div>
                    )}
                    {!catalogHint && hasRawUrl(content) && (
                      <p className="flex items-center gap-1 text-xs text-warning">
                        <TriangleAlert size={12} />
                        Este texto lleva un enlace escrito a mano; si es un catálogo, usa el marcador para que se
                        actualice solo.
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onPress={() => photoInputRef.current?.click()}
                        isDisabled={mediaPaths.length + uploadingCount >= QUICK_REPLY_MAX_PHOTOS}
                      >
                        <ImagePlus size={13} />
                        Agregar fotos
                      </Button>
                      <span className="flex items-center gap-2 text-xs text-muted">
                        {uploadingCount > 0 && <span role="status">Subiendo…</span>}
                        <span className="lm-num">
                          {mediaPaths.length} de {QUICK_REPLY_MAX_PHOTOS}
                        </span>
                      </span>
                    </div>
                    <input
                      ref={photoInputRef}
                      type="file"
                      accept="image/jpeg,image/png"
                      multiple
                      hidden
                      onChange={handlePhotosChosen}
                    />
                    {mediaPaths.length > 0 && (
                      <ul className="qr-photos">
                        {mediaPaths.map((path, index) => (
                          <li key={path} className="qr-photo">
                            {/* eslint-disable-next-line @next/next/no-img-element -- ruta propia con sesión (/api/media), no una imagen optimizable */}
                            <img src={mediaUrlFor(path)} alt={`Foto ${index + 1} de la respuesta rápida`} />
                            <button
                              type="button"
                              className="qr-photo-remove"
                              onClick={() => removePhoto(index)}
                              aria-label={`Quitar foto ${index + 1}`}
                            >
                              <X size={12} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {!editingId && (
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={onlyForMe}
                        onChange={(e) => setOnlyForMe(e.target.checked)}
                        className="h-4 w-4"
                      />
                      Solo para mí
                    </label>
                  )}
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onPress={closeForm}>
                      Cancelar
                    </Button>
                    <Button size="sm" variant="primary" onPress={handleSave} isDisabled={isSaving || uploadingCount > 0}>
                      {editingId ? "Guardar cambios" : "Agregar"}
                    </Button>
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-2">
                {porTitulo.map(renderRow)}
                {porTexto.length > 0 && (
                  <p className="mt-1 text-xs font-medium uppercase tracking-wide text-muted">También en el texto</p>
                )}
                {porTexto.map(renderRow)}
                {!hayResultados && hayConsulta && (
                  <p className="text-sm text-muted">Ningún mensaje coincide con «{query.trim()}».</p>
                )}
                {!hayResultados && !hayConsulta && tabReplies.length > 0 && (
                  <p className="text-sm text-muted">
                    {mediaFilter === "fotos"
                      ? "Ningún mensaje de esta pestaña lleva fotos."
                      : "Todos los mensajes de esta pestaña llevan fotos."}
                  </p>
                )}
                {tabReplies.length === 0 && !isFormOpen && (
                  <p className="text-sm text-muted">
                    {tab === "mine"
                      ? "Todavía no tienes mensajes propios. Crea tus saludos con tu nombre: solo tú los verás."
                      : "Todavía no hay mensajes rápidos creados."}
                  </p>
                )}
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => onOpenChange(false)}>
                Cerrar
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
