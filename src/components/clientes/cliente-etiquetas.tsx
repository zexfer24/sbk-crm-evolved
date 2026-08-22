"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { toast } from "@heroui/react";
import type { Contact, Tag } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { addTagToContact, removeTagFromContact } from "@/lib/mutations";

/**
 * Las mismas etiquetas del panel del chat, editables desde la ficha. El
 * catálogo de etiquetas no se gestiona acá: eso sigue viviendo en el chat,
 * que es donde se usa a diario.
 */
export function ClienteEtiquetas({ contact, allTags }: { contact: Contact; allTags: Tag[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const assigned = new Set(contact.tags.map((tag) => tag.id));
  const available = allTags.filter((tag) => !assigned.has(tag.id));

  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true);
    try {
      await action();
      router.refresh();
    } catch {
      toast.danger(fallback);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cli-tags-editor">
      <div className="crm-tags">
        {contact.tags.map((tag) => (
          <span className="crm-tag" key={tag.id} data-color={tag.color}>
            {tag.label}
            <button
              className="crm-tag-x"
              type="button"
              disabled={busy}
              aria-label={`Quitar etiqueta ${tag.label}`}
              onClick={() =>
                run(
                  () => removeTagFromContact(createClient(), contact.id, tag.id),
                  "No se pudo quitar la etiqueta."
                )
              }
            >
              <X size={11} />
            </button>
          </span>
        ))}
        {contact.tags.length === 0 && <span className="cli-missing">Sin etiquetas todavía</span>}
      </div>

      {available.length > 0 && (
        <>
          <p className="lm-eyebrow cli-tags-add-label">Agregar</p>
          <div className="crm-tags">
            {available.map((tag) => (
              <button
                className="crm-tag cli-tag-add"
                key={tag.id}
                type="button"
                data-color={tag.color}
                disabled={busy}
                onClick={() =>
                  run(() => addTagToContact(createClient(), contact.id, tag.id), "No se pudo añadir la etiqueta.")
                }
              >
                <Plus size={11} />
                {tag.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
