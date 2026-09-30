"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { formatDistanceStrict } from "date-fns";
import { es } from "date-fns/locale";
import { AlertTriangle, Ellipsis, Search, SquareKanban, UserRound, X } from "lucide-react";
import { toast } from "@heroui/react";
import type { Agent, ConversationSummary, Tag } from "@/lib/types";
import { BUSINESS_NAME } from "@/lib/brand";
import { DEFAULT_BUSINESS_HOURS, type BusinessHours } from "@/lib/business-hours";
import { createClient } from "@/lib/supabase/client";
import { fetchCaseBoard, fetchConversationRow, fetchTags } from "@/lib/data";
import { addTagToContact, removeTagFromContact } from "@/lib/mutations";
import { useLiveConversations } from "@/lib/use-live-conversations";
import { useClock } from "@/lib/use-clock";
import { contactName, initials, isStalled } from "@/lib/dashboard";
import {
  CASE_BOARD_LIMIT,
  NO_AGENT_FILTER,
  UNTAGGED_COLUMN_ID,
  UNTAGGED_COLUMN_LABEL,
  applyTagMove,
  buildCaseBoard,
  planTagMove,
  type CaseColumn,
} from "@/lib/case-board";
import { AppRail, AppTopNav } from "@/components/app-rail";
import "@/components/dashboard/dashboard.css";
import "@/components/casos/case-board.css";

/**
 * La sección «Casos» (T7, plan "La ronda del cliente", 30/9/2026): los chats
 * abiertos repartidos en columnas por etiqueta del contacto. Arrastrar una
 * tarjeta a otra columna le cambia la etiqueta; en táctil y con teclado, el
 * menú «Mover a…» de cada tarjeta hace exactamente lo mismo (el arrastre de
 * HTML5 no existe ni en el dedo ni en el tabulador).
 *
 * Las reglas —qué columnas hay, qué se quita y qué se pone— viven en
 * `lib/case-board.ts`, puras; acá solo se pinta y se habla con la base.
 */

/** Tipo del dato que viaja en el arrastre: propio, para no aceptar un texto o un archivo soltado encima. */
const DRAG_MIME = "application/x-sbk-caso";

interface DragPayload {
  conversationId: string;
  contactId: string;
  fromColumnId: string;
}

interface CaseBoardViewProps {
  currentAgent: Agent;
  initialConversations: ConversationSummary[];
  /** El servidor trajo el tope (`CASE_BOARD_LIMIT`) y había más: la pantalla lo dice. */
  truncated: boolean;
  tags: Tag[];
  agents: Agent[];
  /** Para medir "atascado" en minutos laborales, igual que el Recorrido. */
  businessHours?: BusinessHours;
}

function readPayload(event: ReactDragEvent): DragPayload | null {
  try {
    const raw = event.dataTransfer?.getData(DRAG_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DragPayload>;
    if (typeof parsed.conversationId !== "string" || typeof parsed.contactId !== "string") return null;
    if (typeof parsed.fromColumnId !== "string") return null;
    return parsed as DragPayload;
  } catch {
    return null;
  }
}

function relativeTime(iso: string | null, now: number): string {
  if (!iso) return "sin mensajes";
  const at = Date.parse(iso);
  // El reloj de la vista va por minuto (useClock): lo de hace segundos es "ahora".
  if (now - at < 60_000) return "ahora";
  return formatDistanceStrict(at, now, { locale: es, addSuffix: true });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * La tarjeta que el cursor lleva durante el arrastre. Sin esto, el navegador
 * usa una foto plana de la tarjeta; con esto, la misma tarjeta sale apenas
 * levantada y girada, y el hueco que deja en su columna se atenúa (CSS). El
 * clon vive fuera de pantalla solo el instante que el navegador tarda en
 * fotografiarlo.
 */
function liftDragImage(event: ReactDragEvent<HTMLElement>) {
  const dataTransfer = event.dataTransfer;
  const source = event.currentTarget;
  if (!dataTransfer || typeof dataTransfer.setDragImage !== "function") return;
  try {
    const rect = source.getBoundingClientRect();
    const ghost = document.createElement("div");
    ghost.className = "cb-ghost";
    const clone = source.cloneNode(true) as HTMLElement;
    clone.classList.add("cb-ghost-card");
    clone.removeAttribute("data-dragging");
    clone.style.width = `${rect.width}px`;
    ghost.appendChild(clone);
    document.body.appendChild(ghost);
    const padding = 18;
    dataTransfer.setDragImage(ghost, event.clientX - rect.left + padding, event.clientY - rect.top + padding);
    window.setTimeout(() => ghost.remove(), 0);
  } catch {
    // La foto por defecto del navegador también sirve.
  }
}

export function CaseBoardView({
  currentAgent,
  initialConversations,
  truncated: initialTruncated,
  tags: initialTags,
  agents,
  businessHours = DEFAULT_BUSINESS_HOURS,
}: CaseBoardViewProps) {
  const supabase = useMemo(() => createClient(), []);
  const [truncated, setTruncated] = useState(initialTruncated);

  const fetcher = useCallback(async () => {
    const board = await fetchCaseBoard(supabase);
    setTruncated(board.truncated);
    return board.conversations;
  }, [supabase]);
  const fetchRow = useCallback((id: string) => fetchConversationRow(supabase, id), [supabase]);

  const { conversations, setConversations, refreshConversations } = useLiveConversations(
    supabase,
    initialConversations,
    { fetcher, fetchRow, watchContactTags: true, channelName: "casos-conversations" }
  );

  // Las columnas son las etiquetas: una creada, renombrada o borrada desde la
  // bandeja se refleja acá sin recargar.
  const [tags, setTags] = useState(initialTags);
  useEffect(() => {
    let alive = true;
    const channel = supabase
      .channel("casos-etiquetas")
      .on("postgres_changes", { event: "*", schema: "public", table: "tags" }, () => {
        fetchTags(supabase)
          .then((next) => {
            if (alive) setTags(next);
          })
          .catch(() => {
            // El próximo cambio vuelve a intentarlo; las columnas de ahora siguen sirviendo.
          });
      })
      .subscribe();
    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  const now = useClock();
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState("");

  // Un chat que se cierra llega por realtime como una fila con otro estado:
  // sale del tablero en el acto, sin esperar al siguiente refresco. «Abierto»
  // es todo lo que no está cerrado, como en `fetchCaseBoard`.
  const openConversations = useMemo(() => conversations.filter((c) => c.status !== "closed"), [conversations]);

  const columns = useMemo(
    () =>
      buildCaseBoard(openConversations, tags, {
        query,
        agentId: agentFilter || null,
        now: new Date(now),
        hours: businessHours,
      }),
    [openConversations, tags, query, agentFilter, now, businessHours]
  );

  // Atascados del tablero entero sobre chats ÚNICOS, no sumando columnas: un
  // contacto con dos etiquetas saldría contado dos veces (misma lección que
  // `countStalled` del Recorrido, 10/9/2026).
  const stalledTotal = useMemo(
    () => openConversations.filter((c) => isStalled(c, now, businessHours)).length,
    [openConversations, now, businessHours]
  );

  const filtering = query.trim() !== "" || agentFilter !== "";
  const visibleCount = useMemo(() => new Set(columns.flatMap((c) => c.cards.map((card) => card.id))).size, [columns]);

  const tagById = useCallback(
    (id: string) =>
      tags.find((t) => t.id === id) ??
      openConversations.flatMap((c) => c.contact.tags).find((t) => t.id === id),
    [tags, openConversations]
  );

  // Contactos con un movimiento en vuelo: otro gesto sobre el mismo contacto
  // esperaría a que termine, para no pisar la reversión de uno con el otro.
  const pendingRef = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const setContactTags = useCallback(
    (contactId: string, nextTags: Tag[]) => {
      setConversations((current) =>
        current.map((c) => (c.contact.id === contactId ? { ...c, contact: { ...c.contact, tags: nextTags } } : c))
      );
    },
    [setConversations]
  );

  const moveCard = useCallback(
    async (payload: DragPayload, toColumnId: string) => {
      const { contactId, fromColumnId } = payload;
      if (pendingRef.current.has(contactId)) return;

      const conversation = conversations.find((c) => c.contact.id === contactId);
      if (!conversation) return;

      const previousTags = conversation.contact.tags;
      const plan = planTagMove(
        fromColumnId,
        toColumnId,
        previousTags.map((t) => t.id)
      );
      if (!plan) return;

      const nextTags = applyTagMove(previousTags, plan, tagById);
      const toLabel = toColumnId === UNTAGGED_COLUMN_ID ? UNTAGGED_COLUMN_LABEL : (tagById(toColumnId)?.label ?? "");
      const fromLabel = tagById(fromColumnId)?.label ?? "";

      pendingRef.current.add(contactId);
      setPending(new Set(pendingRef.current));
      setContactTags(contactId, nextTags);

      try {
        // Primero PONER y después QUITAR: si algo se corta entre las dos, el
        // contacto queda con las dos etiquetas —visible en dos columnas— y
        // nunca un instante sin ninguna, que lo mandaría a «Sin etiqueta».
        if (plan.add) await addTagToContact(supabase, contactId, plan.add);
        if (plan.remove) await removeTagFromContact(supabase, contactId, plan.remove);

        if (toColumnId === UNTAGGED_COLUMN_ID && nextTags.length > 0) {
          toast.success(`Se quitó la etiqueta ${fromLabel}`);
        } else {
          toast.success(`Movido a ${toLabel}`);
        }
      } catch {
        setContactTags(contactId, previousTags);
        toast.danger(`No se pudo mover el chat a ${toLabel}. Quedó donde estaba; vuelve a intentarlo.`);
        // Poner la de destino pudo haber llegado a la base antes de que
        // fallara quitar la de origen: se vuelve a leer la verdad.
        void refreshConversations();
      } finally {
        pendingRef.current.delete(contactId);
        setPending(new Set(pendingRef.current));
      }
    },
    [conversations, tagById, setContactTags, supabase, refreshConversations]
  );

  // Estado del arrastre en curso: qué tarjeta se levantó y qué columna la recibiría.
  const dragRef = useRef<DragPayload | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [receiving, setReceiving] = useState<string | null>(null);

  function endDrag() {
    dragRef.current = null;
    setDragging(null);
    setReceiving(null);
  }

  function isOurDrag(event: ReactDragEvent) {
    if (dragRef.current) return true;
    return Array.from(event.dataTransfer?.types ?? []).includes(DRAG_MIME);
  }

  function handleDragOver(event: ReactDragEvent<HTMLElement>, columnId: string) {
    if (!isOurDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const from = dragRef.current?.fromColumnId;
    const next = from === columnId ? null : columnId;
    if (receiving !== next) setReceiving(next);
  }

  function handleDragLeave(event: ReactDragEvent<HTMLElement>, columnId: string) {
    const related = event.relatedTarget as Node | null;
    if (related && event.currentTarget.contains(related)) return;
    if (receiving === columnId) setReceiving(null);
  }

  function handleDrop(event: ReactDragEvent<HTMLElement>, columnId: string) {
    if (!isOurDrag(event)) return;
    event.preventDefault();
    const payload = readPayload(event) ?? dragRef.current;
    endDrag();
    if (payload) void moveCard(payload, columnId);
  }

  const agentOptions = useMemo(() => agents.filter((a) => a.isActive), [agents]);

  return (
    <div className="dash">
      <div className="dash-frame">
        <AppRail active="casos" />

        <main className="dash-main">
          <div className="dash-content cb-content">
            <header className="dash-topbar">
              <p className="dash-brand">
                <span className="dash-brand-mark" aria-hidden="true">
                  <SquareKanban size={14} />
                </span>
                <span className="dash-brand-name">{BUSINESS_NAME}</span>
              </p>

              <AppTopNav active="casos" />

              <div className="dash-topbar-actions">
                <span className="dash-icon-btn dash-icon-static" title={currentAgent.displayName}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{initials(currentAgent.displayName)}</span>
                </span>
              </div>
            </header>

            <div className="cb-head">
              <div className="cb-head-text">
                <h1 className="dash-title dash-display">Casos</h1>
                <p className="dash-subtitle cb-subtitle">
                  <span className="dash-num">{plural(openConversations.length, "chat abierto", "chats abiertos")}</span>
                  {stalledTotal > 0 && (
                    <>
                      <span aria-hidden="true"> · </span>
                      <span className="cb-subtitle-hot dash-num">{plural(stalledTotal, "atascado", "atascados")}</span>
                    </>
                  )}
                  <span className="cb-subtitle-hint"> Arrastra un chat a otra columna para cambiarle la etiqueta.</span>
                </p>
              </div>

              <div className="cb-tools">
                <label className="cb-search">
                  <Search size={15} aria-hidden="true" />
                  <input
                    type="search"
                    placeholder="Nombre o teléfono"
                    aria-label="Buscar por nombre o teléfono"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <select
                  className="cb-select"
                  aria-label="Filtrar por asesor"
                  value={agentFilter}
                  onChange={(event) => setAgentFilter(event.target.value)}
                >
                  <option value="">Todos los asesores</option>
                  <option value={NO_AGENT_FILTER}>Sin asesor</option>
                  {agentOptions.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.displayName}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {truncated && (
              <p className="cb-notice" role="status">
                <AlertTriangle size={14} aria-hidden="true" />
                Mostrando los {CASE_BOARD_LIMIT} chats abiertos más recientes. Los más viejos siguen en la Bandeja.
              </p>
            )}

            {filtering && visibleCount === 0 ? (
              <div className="dash-empty cb-noresults" role="status">
                <Search size={26} aria-hidden="true" />
                <p className="dash-empty-title">Ningún chat abierto coincide con la búsqueda</p>
                <p className="dash-empty-hint">Prueba con otra parte del nombre o del número, o quita el filtro de asesor.</p>
                <button
                  type="button"
                  className="cb-clear"
                  onClick={() => {
                    setQuery("");
                    setAgentFilter("");
                  }}
                >
                  <X size={14} aria-hidden="true" />
                  Quitar filtros
                </button>
              </div>
            ) : (
              <div className="cb-board">
                {columns.map((column, index) => (
                  <BoardColumn
                    key={column.id}
                    column={column}
                    index={index}
                    columns={columns}
                    now={now}
                    businessHours={businessHours}
                    receiving={receiving === column.id}
                    dragging={dragging}
                    pending={pending}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onCardDragStart={(event, payload) => {
                      if (!event.dataTransfer) return;
                      event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
                      event.dataTransfer.effectAllowed = "move";
                      liftDragImage(event);
                      dragRef.current = payload;
                      setDragging(`${payload.fromColumnId}:${payload.conversationId}`);
                    }}
                    onCardDragEnd={endDrag}
                    onMove={(payload, toColumnId) => void moveCard(payload, toColumnId)}
                  />
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

interface BoardColumnProps {
  column: CaseColumn;
  index: number;
  columns: CaseColumn[];
  now: number;
  businessHours: BusinessHours;
  receiving: boolean;
  dragging: string | null;
  pending: ReadonlySet<string>;
  onDragOver: (event: ReactDragEvent<HTMLElement>, columnId: string) => void;
  onDragLeave: (event: ReactDragEvent<HTMLElement>, columnId: string) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>, columnId: string) => void;
  onCardDragStart: (event: ReactDragEvent<HTMLElement>, payload: DragPayload) => void;
  onCardDragEnd: () => void;
  onMove: (payload: DragPayload, toColumnId: string) => void;
}

function BoardColumn({
  column,
  index,
  columns,
  now,
  businessHours,
  receiving,
  dragging,
  pending,
  onDragOver,
  onDragLeave,
  onDrop,
  onCardDragStart,
  onCardDragEnd,
  onMove,
}: BoardColumnProps) {
  const untagged = column.id === UNTAGGED_COLUMN_ID;

  return (
    <section
      className="cb-column"
      aria-label={`${column.label}, ${plural(column.count, "chat", "chats")}`}
      data-column-id={column.id}
      data-color={column.color ?? "none"}
      data-receiving={receiving ? "true" : undefined}
      // El escalonado de entrada se topa en 8: con muchas etiquetas, la
      // última no puede tardar un segundo en aparecer.
      style={{ "--cb-i": Math.min(index, 8) } as CSSProperties}
      onDragEnter={(event) => onDragOver(event, column.id)}
      onDragOver={(event) => onDragOver(event, column.id)}
      onDragLeave={(event) => onDragLeave(event, column.id)}
      onDrop={(event) => onDrop(event, column.id)}
    >
      <header className="cb-column-head">
        <span className="cb-column-dot" aria-hidden="true" />
        <h2 className="cb-column-title" title={column.label}>
          {column.label}
        </h2>
        {column.stalled > 0 && (
          <span className="cb-stalled" title="Chats de esta columna que ya pasaron su tiempo de espera">
            <span className="dash-num">{column.stalled}</span>
            {column.stalled === 1 ? " atascado" : " atascados"}
          </span>
        )}
        <span className="cb-column-count dash-num">{column.count}</span>
      </header>

      {receiving && (
        <p className="cb-drop-hint" aria-hidden="true">
          {untagged ? "Soltar para quitar la etiqueta" : `Soltar en ${column.label}`}
        </p>
      )}

      {column.cards.length === 0 ? (
        <p className="cb-column-empty">Arrastra aquí un chat</p>
      ) : (
        <ul className="cb-cards">
          {column.cards.map((conversation) => (
            <li key={conversation.id}>
              <CaseCard
                conversation={conversation}
                columnId={column.id}
                columns={columns}
                now={now}
                stalled={isStalled(conversation, now, businessHours)}
                dragging={dragging === `${column.id}:${conversation.id}`}
                pending={pending.has(conversation.contact.id)}
                onDragStart={onCardDragStart}
                onDragEnd={onCardDragEnd}
                onMove={onMove}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface CaseCardProps {
  conversation: ConversationSummary;
  columnId: string;
  columns: CaseColumn[];
  now: number;
  stalled: boolean;
  dragging: boolean;
  pending: boolean;
  onDragStart: (event: ReactDragEvent<HTMLElement>, payload: DragPayload) => void;
  onDragEnd: () => void;
  onMove: (payload: DragPayload, toColumnId: string) => void;
}

function CaseCard({
  conversation,
  columnId,
  columns,
  now,
  stalled,
  dragging,
  pending,
  onDragStart,
  onDragEnd,
  onMove,
}: CaseCardProps) {
  const name = contactName(conversation);
  const payload: DragPayload = {
    conversationId: conversation.id,
    contactId: conversation.contact.id,
    fromColumnId: columnId,
  };
  const unread = conversation.unreadCount;

  return (
    <article
      className="cb-card"
      draggable={!pending}
      data-dragging={dragging ? "true" : undefined}
      data-pending={pending ? "true" : undefined}
      data-stalled={stalled ? "true" : undefined}
      onDragStart={(event) => onDragStart(event, payload)}
      onDragEnd={onDragEnd}
    >
      {/* El enlace cubre la tarjeta entera (su ::after), pero no se arrastra
          solo: sin `draggable={false}` el navegador arrastraría la URL en vez
          de la tarjeta. */}
      <Link className="cb-card-link" href={`/inbox?conversation=${conversation.id}`} draggable={false}>
        <span className="cb-card-top">
          <span className="cb-card-avatar" aria-hidden="true">
            {initials(name)}
            {stalled && <span className="cb-card-alert" />}
          </span>
          <span className="cb-card-name">{name}</span>
          <span className="cb-card-time">{relativeTime(conversation.lastMessageAt, now)}</span>
        </span>
        {stalled && <span className="cb-sr">Atascado.</span>}
        <span className="cb-card-preview" data-empty={conversation.lastMessagePreview ? undefined : "true"}>
          {conversation.lastMessagePreview ?? "Todavía no hay mensajes"}
        </span>
      </Link>

      <span className="cb-card-foot">
        <span className="cb-card-agent" data-empty={conversation.assignedAgent ? undefined : "true"}>
          <UserRound size={12} aria-hidden="true" />
          {conversation.assignedAgent?.displayName ?? "Sin asesor"}
        </span>
        {unread > 0 ? (
          <span className="cb-unread dash-num" aria-label={`${unread} sin leer`}>
            {unread > 99 ? "99+" : unread}
          </span>
        ) : conversation.manuallyUnread ? (
          <span className="cb-unread-dot" aria-label="Marcado como no leído" />
        ) : null}
        <MoveMenu columns={columns} currentColumnId={columnId} disabled={pending} onPick={(to) => onMove(payload, to)} />
      </span>
    </article>
  );
}

interface MoveMenuProps {
  columns: CaseColumn[];
  currentColumnId: string;
  disabled: boolean;
  onPick: (toColumnId: string) => void;
}

/**
 * La alternativa al arrastre para el dedo y el teclado. Se monta en un
 * portal: la lista de tarjetas scrollea, y un menú absoluto dentro de ella
 * quedaría recortado por su propio contenedor.
 */
function MoveMenu({ columns, currentColumnId, disabled, onPick }: MoveMenuProps) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const targets = columns.filter((c) => c.id !== currentColumnId);
  const open = position !== null;

  const close = useCallback((restoreFocus: boolean) => {
    setPosition(null);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    }
    // El menú está anclado a un punto de la pantalla: si algo scrollea
    // debajo, deja de apuntar a su tarjeta y se cierra.
    function onScroll(event: Event) {
      if (menuRef.current?.contains(event.target as Node)) return;
      close(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, close]);

  function toggle() {
    if (open) {
      close(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    const width = 232;
    const left = rect ? Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) : 8;
    setPosition({ top: rect ? rect.bottom + 6 : 8, left });
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") {
      close(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(at + 1) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(at - 1 + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="cb-card-menu-btn"
        aria-label="Mover a…"
        title="Mover a…"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={toggle}
      >
        <Ellipsis size={16} aria-hidden="true" />
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="cb-menu"
            role="menu"
            aria-label="Mover a…"
            style={{ top: position.top, left: position.left }}
            onKeyDown={onMenuKeyDown}
          >
            <p className="cb-menu-label" aria-hidden="true">
              Mover a…
            </p>
            {targets.map((target) => (
              <button
                key={target.id}
                type="button"
                role="menuitem"
                className="cb-menu-item"
                data-color={target.color ?? "none"}
                onClick={() => {
                  close(true);
                  onPick(target.id);
                }}
              >
                <span className="cb-column-dot" aria-hidden="true" />
                <span className="cb-menu-item-label">{target.label}</span>
                <span className="cb-menu-item-count dash-num">{target.count}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
