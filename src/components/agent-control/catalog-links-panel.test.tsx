/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CatalogLinksPanel } from "@/components/agent-control/catalog-links-panel";
import type { CatalogLink, Playbook, QuickReply } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mismo patrón que playbooks-panel.test.tsx: el toast real de HeroUI no
// aporta nada acá y complica el DOM; el resto del módulo (Button, Input,
// Label) queda intacto para poder escribir y guardar como lo haría alguien
// de verdad.
// ---------------------------------------------------------------------------
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { success: vi.fn(), danger: vi.fn() } };
});

function link(overrides: Partial<CatalogLink> = {}): CatalogLink {
  return {
    id: "link-1",
    key: "cascos",
    label: "Cascos",
    url: "https://drive.google.com/file/d/abc123",
    sortOrder: 1,
    isActive: true,
    updatedBy: "agent-1",
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  };
}

function playbook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: "pb-1",
    name: "Catálogo general",
    triggerDescription: "el cliente pregunta por el catálogo",
    responseText: "Acá va el catálogo 👇",
    attachmentUrl: null,
    attachmentType: null,
    afterSend: "wait",
    isActive: true,
    tags: [],
    ...overrides,
  };
}

function quickReply(overrides: Partial<QuickReply> = {}): QuickReply {
  return { id: "qr-1", label: "Catálogo", content: "Acá va el catálogo", ...overrides };
}

const onCreate = vi.fn(async () => {});
const onUpdate = vi.fn(async () => {});
const onDelete = vi.fn(async () => {});
const onToggle = vi.fn(async () => {});

beforeEach(() => {
  onCreate.mockClear();
  onUpdate.mockClear();
  onDelete.mockClear();
  onToggle.mockClear();
});

describe("CatalogLinksPanel — crear", () => {
  it("propone la clave a partir de la etiqueta y crea con lo escrito", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(
      <CatalogLinksPanel
        links={[]}
        canEdit
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onToggle={onToggle}
        playbooks={[]}
        quickReplies={[]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Nuevo catálogo" }));
    await user.type(screen.getByLabelText("Etiqueta"), "Exploradoras y Bombillos");

    expect(screen.getByLabelText("Clave del marcador")).toHaveValue("exploradoras-y-bombillos");

    await user.type(screen.getByLabelText("URL"), "https://drive.google.com/file/d/xyz");
    await user.click(screen.getByRole("button", { name: "Crear catálogo" }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        key: "exploradoras-y-bombillos",
        label: "Exploradoras y Bombillos",
        url: "https://drive.google.com/file/d/xyz",
      })
    );
  });

  it("una fila inválida no guarda y muestra el mensaje de cada campo", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(
      <CatalogLinksPanel
        links={[]}
        canEdit
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onToggle={onToggle}
        playbooks={[]}
        quickReplies={[]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Nuevo catálogo" }));
    await user.click(screen.getByRole("button", { name: "Crear catálogo" }));

    expect(await screen.findAllByRole("alert")).toHaveLength(3);
    expect(screen.getByText("La clave no puede estar vacía.")).toBeInTheDocument();
    expect(screen.getByText("La etiqueta no puede estar vacía.")).toBeInTheDocument();
    expect(screen.getByText("La URL debe empezar con http:// o https://.")).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe("CatalogLinksPanel — solo lectura", () => {
  it("canEdit=false esconde crear/editar/borrar/activar pero deja copiar el marcador", () => {
    render(
      <CatalogLinksPanel
        links={[link()]}
        canEdit={false}
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onToggle={onToggle}
        playbooks={[]}
        quickReplies={[]}
      />
    );

    expect(screen.queryByRole("button", { name: "Nuevo catálogo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Editar Cascos" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Borrar/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copiar marcador" })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Corrección de la revisión `code-review high` del 19/9/2026, punto 4: (a)
// renombrar la clave rompe en silencio todos los textos que ya la usan —
// queda de solo lectura al editar; (b) desactivar una clave en uso tiene el
// mismo patrón "armar y confirmar" que borrar, porque también deja textos
// sin resolver; activar no pide nada porque nunca rompe nada.
// ---------------------------------------------------------------------------
describe("CatalogLinksPanel — editar: la clave es de solo lectura", () => {
  it("al editar, el campo Clave queda deshabilitado y explica por qué", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(
      <CatalogLinksPanel
        links={[link({ key: "cascos" })]}
        canEdit
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onToggle={onToggle}
        playbooks={[]}
        quickReplies={[]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Editar Cascos" }));

    expect(screen.getByLabelText("Clave del marcador")).toBeDisabled();
    expect(screen.getByText(/no se puede cambiar/i)).toBeInTheDocument();
  });

  it("al crear (sin editar nada), la clave sigue editable", async () => {
    render(
      <CatalogLinksPanel
        links={[]}
        canEdit
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onToggle={onToggle}
        playbooks={[]}
        quickReplies={[]}
      />
    );

    await userEvent.setup({ delay: null, pointerEventsCheck: 0 }).click(
      screen.getByRole("button", { name: "Nuevo catálogo" })
    );

    expect(screen.getByLabelText("Clave del marcador")).not.toBeDisabled();
  });
});

describe("CatalogLinksPanel — desactivar avisa cuántos textos usan la clave; activar no pide nada", () => {
  it("desactivar con usos arma la confirmación con la cuenta, y el segundo clic desactiva", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(
      <CatalogLinksPanel
        links={[link({ key: "cascos", isActive: true })]}
        canEdit
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onToggle={onToggle}
        playbooks={[playbook({ id: "pb-1", responseText: "Mira {{catalogo:cascos}}" })]}
        quickReplies={[quickReply({ id: "qr-1", content: "Acá: {{catalogo:cascos}}" })]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Apagar el catálogo Cascos" }));

    const confirmar = await screen.findByRole("button", {
      name: "¿Desactivar? Lo usan 1 escenario y 1 mensaje rápido",
    });
    expect(onToggle).not.toHaveBeenCalled();

    await user.click(confirmar);

    await waitFor(() => expect(onToggle).toHaveBeenCalledWith("link-1", false));
  });

  it("desactivar sin ningún uso también pide confirmar, con texto genérico", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(
      <CatalogLinksPanel
        links={[link({ key: "ubicacion", isActive: true })]}
        canEdit
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onToggle={onToggle}
        playbooks={[]}
        quickReplies={[]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Apagar el catálogo Cascos" }));

    const confirmar = await screen.findByRole("button", { name: "¿Confirmar apagar?" });
    await user.click(confirmar);

    await waitFor(() => expect(onToggle).toHaveBeenCalledWith("link-1", false));
  });

  it("activar no pide ninguna confirmación: un solo clic alcanza", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(
      <CatalogLinksPanel
        links={[link({ key: "cascos", isActive: false })]}
        canEdit
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onToggle={onToggle}
        playbooks={[playbook({ id: "pb-1", responseText: "Mira {{catalogo:cascos}}" })]}
        quickReplies={[]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Activar el catálogo Cascos" }));

    await waitFor(() => expect(onToggle).toHaveBeenCalledWith("link-1", true));
  });

  /**
   * D3/D4: `{{catalogos}}` necesita AL MENOS un catálogo activo para no ser
   * `missing` (`resolveCatalogMarkers`). Si esta es la ÚLTIMA activa,
   * apagarla rompe también cualquier texto con `{{catalogos}}`, aunque no la
   * mencione por su clave puntual.
   */
  it("cuenta {{catalogos}} como uso cuando el enlace es el ÚLTIMO activo", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(
      <CatalogLinksPanel
        links={[link({ id: "link-1", key: "cascos", isActive: true })]}
        canEdit
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onToggle={onToggle}
        playbooks={[playbook({ id: "pb-1", responseText: "Ver también: {{catalogos}}" })]}
        quickReplies={[]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Apagar el catálogo Cascos" }));

    expect(
      await screen.findByRole("button", { name: "¿Desactivar? Lo usan 1 escenario" })
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 20/9/2026, "El resguardo antes del push" (T3-b): dos mínimos sobre
// `handleSave` al EDITAR que no tenían test hermano. `otherLinks` (línea
// ~150) ya filtra la propia fila antes de validar duplicados -- sin un test
// que guarde de verdad en modo edición, una regresión ahí (comparar la fila
// contra sí misma) pasaría desapercibida hasta producción.
// ---------------------------------------------------------------------------
describe("CatalogLinksPanel — guardar en modo edición no se choca con la propia fila", () => {
  it("editar sin cambiar la clave guarda sin el error 'clave repetida'", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(
      <CatalogLinksPanel
        links={[link({ id: "link-1", key: "cascos", label: "Cascos" })]}
        canEdit
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onToggle={onToggle}
        playbooks={[]}
        quickReplies={[]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Editar Cascos" }));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    expect(screen.queryByText("Ya existe un catálogo con esa clave.")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith("link-1", {
        key: "cascos",
        label: "Cascos",
        url: link().url,
      })
    );
  });

  it("editar solo la etiqueta no le pisa la clave con un slug recalculado", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(
      <CatalogLinksPanel
        links={[link({ id: "link-1", key: "cascos", label: "Cascos" })]}
        canEdit
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onToggle={onToggle}
        playbooks={[]}
        quickReplies={[]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Editar Cascos" }));
    await user.type(screen.getByLabelText("Etiqueta"), " y accesorios");
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    // La clave viaja intacta -- nunca "cascos-y-accesorios", que sería el
    // slug de la etiqueta nueva si `keyTouched` no bloqueara el recálculo.
    expect(onUpdate).toHaveBeenCalledWith("link-1", expect.objectContaining({ key: "cascos" }));
  });
});

// 20/9/2026, "El resguardo antes del push" (T3-b, mínimo explícito): con DOS
// catálogos activos, apagar UNO no debería contar `{{catalogos}}` como uso
// -- la lista completa sigue teniendo al otro para resolverse. Sin este test,
// una regresión que dejara `wouldEmptyList` fijo en `true` (o que ignorara
// `activeCount`) pasaría desapercibida.
describe("CatalogLinksPanel — con dos catálogos activos, apagar uno no vacía la lista", () => {
  it("no cuenta {{catalogos}} como uso: queda el otro catálogo activo para resolverlo", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(
      <CatalogLinksPanel
        links={[
          link({ id: "link-1", key: "cascos", label: "Cascos", isActive: true, sortOrder: 1 }),
          link({ id: "link-2", key: "guantes", label: "Guantes", isActive: true, sortOrder: 2 }),
        ]}
        canEdit
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onToggle={onToggle}
        playbooks={[playbook({ id: "pb-1", responseText: "Ver también: {{catalogos}}" })]}
        quickReplies={[]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Apagar el catálogo Cascos" }));

    // Sin usos puntuales de "cascos" y sin contar {{catalogos}} (queda
    // "guantes" activo), el aviso es el genérico, no el que cuenta usos.
    expect(await screen.findByRole("button", { name: "¿Confirmar apagar?" })).toBeInTheDocument();
  });
});

// 20/9/2026, "El resguardo antes del push" (sospechosa del plan, confirmada):
// `usageOf` también mira `attachmentUrl` -- un escenario puede llevar el
// marcador ahí en vez de (o además de) `responseText`. Sin este test, quitar
// esa rama sobrevivía la suite entera.
describe("CatalogLinksPanel — el marcador en attachmentUrl también cuenta como uso", () => {
  it("un escenario que solo referencia la clave en attachmentUrl (no en responseText) cuenta al borrar", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(
      <CatalogLinksPanel
        links={[link({ key: "cascos" })]}
        canEdit
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onToggle={onToggle}
        playbooks={[
          playbook({
            id: "pb-1",
            responseText: "Acá va el catálogo",
            attachmentUrl: "{{catalogo:cascos}}",
          }),
        ]}
        quickReplies={[]}
      />
    );

    await user.click(screen.getByRole("button", { name: /^Borrar$/ }));

    expect(screen.getByText("¿Borrar? Lo usan 1 escenario")).toBeInTheDocument();
  });
});

describe("CatalogLinksPanel — copiar marcador", () => {
  it("copia el marcador canónico al portapapeles", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    // `userEvent.setup()` instala SU PROPIO stub de `navigator.clipboard` (con
    // `writeText` real, que sí guarda el texto) apenas se llama — un mock
    // propio puesto ANTES quedaría pisado. Se espía el método real con
    // `vi.spyOn` en vez de reemplazarlo, así el clic sigue ejecutando el
    // comportamiento de verdad y el espía solo registra la llamada.
    const writeTextSpy = vi.spyOn(navigator.clipboard, "writeText");
    const { toast } = await import("@heroui/react");
    render(
      <CatalogLinksPanel
        links={[link({ key: "cascos" })]}
        canEdit
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onToggle={onToggle}
        playbooks={[]}
        quickReplies={[]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Copiar marcador" }));

    await waitFor(() => expect(writeTextSpy).toHaveBeenCalledWith("{{catalogo:cascos}}"));
    expect(toast.success).toHaveBeenCalledWith("Marcador copiado");
  });
});

describe("CatalogLinksPanel — borrar avisa cuántos textos usan la clave", () => {
  it("el primer clic muestra la cuenta de escenarios y mensajes rápidos; el segundo borra", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(
      <CatalogLinksPanel
        links={[link({ key: "cascos" })]}
        canEdit
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onToggle={onToggle}
        playbooks={[
          playbook({ id: "pb-1", responseText: "Mira {{catalogo:cascos}}" }),
          playbook({ id: "pb-2", responseText: "{{catalogo:cascos}} y {{catalogo:otro}}" }),
        ]}
        quickReplies={[quickReply({ id: "qr-1", content: "Acá: {{catalogo:cascos}}" })]}
      />
    );

    await user.click(screen.getByRole("button", { name: /^Borrar$/ }));

    expect(screen.getByText("¿Borrar? Lo usan 2 escenarios y 1 mensaje rápido")).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();

    await user.click(screen.getByText("¿Borrar? Lo usan 2 escenarios y 1 mensaje rápido"));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("link-1"));
  });

  it("sin ningún uso, el segundo clic pide confirmar sin contar nada", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(
      <CatalogLinksPanel
        links={[link({ key: "ubicacion" })]}
        canEdit
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onToggle={onToggle}
        playbooks={[]}
        quickReplies={[]}
      />
    );

    await user.click(screen.getByRole("button", { name: /^Borrar$/ }));

    expect(screen.getByText("¿Confirmar borrado?")).toBeInTheDocument();
    await user.click(screen.getByText("¿Confirmar borrado?"));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("link-1"));
  });
});
