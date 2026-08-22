export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]
export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      agent_settings: {
        Row: {
          ai_globally_enabled: boolean
          daily_spend_cap_usd: number | null
          id: boolean
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          ai_globally_enabled?: boolean
          daily_spend_cap_usd?: number | null
          id?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          ai_globally_enabled?: boolean
          daily_spend_cap_usd?: number | null
          id?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_suggestions: {
        Row: {
          agent_id: string
          content: string
          created_at: string
          id: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
        }
        Insert: {
          agent_id: string
          content: string
          created_at?: string
          id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
        }
        Update: {
          agent_id?: string
          content?: string
          created_at?: string
          id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_suggestions_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_suggestions_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_turns: {
        Row: {
          action: string
          conversation_id: string
          created_at: string
          customer_message: string | null
          id: string
          input_tokens: number | null
          intent: string | null
          model: string | null
          output_tokens: number | null
          playbook_id: string | null
          summary: string | null
          total_tokens: number | null
        }
        Insert: {
          action: string
          conversation_id: string
          created_at?: string
          customer_message?: string | null
          id?: string
          input_tokens?: number | null
          intent?: string | null
          model?: string | null
          output_tokens?: number | null
          playbook_id?: string | null
          summary?: string | null
          total_tokens?: number | null
        }
        Update: {
          action?: string
          conversation_id?: string
          created_at?: string
          customer_message?: string | null
          id?: string
          input_tokens?: number | null
          intent?: string | null
          model?: string | null
          output_tokens?: number | null
          playbook_id?: string | null
          summary?: string | null
          total_tokens?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_turns_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_turns_playbook_id_fkey"
            columns: ["playbook_id"]
            isOneToOne: false
            referencedRelation: "ai_playbooks"
            referencedColumns: ["id"]
          },
        ]
      }
      agents: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string
          full_name: string | null
          id: string
          is_active: boolean
          last_assigned_at: string | null
          role: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name: string
          full_name?: string | null
          id: string
          is_active?: boolean
          last_assigned_at?: string | null
          role?: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string
          full_name?: string | null
          id?: string
          is_active?: boolean
          last_assigned_at?: string | null
          role?: string
          updated_at?: string
        }
        Relationships: []
      }
      ai_playbooks: {
        Row: {
          after_send: string
          attachment_type: string | null
          attachment_url: string | null
          created_at: string
          id: string
          is_active: boolean
          name: string
          response_text: string
          trigger_description: string
          updated_at: string
        }
        Insert: {
          after_send?: string
          attachment_type?: string | null
          attachment_url?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          response_text: string
          trigger_description: string
          updated_at?: string
        }
        Update: {
          after_send?: string
          attachment_type?: string | null
          attachment_url?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          response_text?: string
          trigger_description?: string
          updated_at?: string
        }
        Relationships: []
      }
      contact_tags: {
        Row: {
          contact_id: string
          created_at: string
          tag_id: string
        }
        Insert: {
          contact_id: string
          created_at?: string
          tag_id: string
        }
        Update: {
          contact_id?: string
          created_at?: string
          tag_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_tags_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_tags_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          address: string | null
          avatar_url: string | null
          cedula_number: string | null
          cedula_type: string | null
          city: string | null
          created_at: string
          display_name: string | null
          id: string
          phone_number: string
          profile_name: string | null
          state: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          avatar_url?: string | null
          cedula_number?: string | null
          cedula_type?: string | null
          city?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          phone_number: string
          profile_name?: string | null
          state?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          avatar_url?: string | null
          cedula_number?: string | null
          cedula_type?: string | null
          city?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          phone_number?: string
          profile_name?: string | null
          state?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      conversation_quotes: {
        Row: {
          bcv_rate: number
          conversation_id: string
          id: string
          price_bs: number
          price_usd: number
          product_id: string | null
          product_name: string
          quoted_at: string
        }
        Insert: {
          bcv_rate: number
          conversation_id: string
          id?: string
          price_bs: number
          price_usd: number
          product_id?: string | null
          product_name: string
          quoted_at?: string
        }
        Update: {
          bcv_rate?: number
          conversation_id?: string
          id?: string
          price_bs?: number
          price_usd?: number
          product_id?: string | null
          product_name?: string
          quoted_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_quotes_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_quotes_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          active_tool: string | null
          ai_enabled: boolean
          ai_turn_running: boolean
          assigned_agent_id: string | null
          contact_id: string
          created_at: string
          deal_closed_at: string | null
          deal_payment_proof_url: string | null
          deal_status: string
          deal_verified: boolean
          deal_verified_at: string | null
          deal_verified_by: string | null
          id: string
          intent: string | null
          journey_stage: string | null
          last_customer_message_at: string | null
          last_message_at: string | null
          last_message_preview: string | null
          order_id: string | null
          status: string
          unread_count: number
          updated_at: string
          welcome_sent_at: string | null
          whatsapp_channel_id: string
        }
        Insert: {
          active_tool?: string | null
          ai_enabled?: boolean
          ai_turn_running?: boolean
          assigned_agent_id?: string | null
          contact_id: string
          created_at?: string
          deal_closed_at?: string | null
          deal_payment_proof_url?: string | null
          deal_status?: string
          deal_verified?: boolean
          deal_verified_at?: string | null
          deal_verified_by?: string | null
          id?: string
          intent?: string | null
          journey_stage?: string | null
          last_customer_message_at?: string | null
          last_message_at?: string | null
          last_message_preview?: string | null
          order_id?: string | null
          status?: string
          unread_count?: number
          updated_at?: string
          welcome_sent_at?: string | null
          whatsapp_channel_id: string
        }
        Update: {
          active_tool?: string | null
          ai_enabled?: boolean
          ai_turn_running?: boolean
          assigned_agent_id?: string | null
          contact_id?: string
          created_at?: string
          deal_closed_at?: string | null
          deal_payment_proof_url?: string | null
          deal_status?: string
          deal_verified?: boolean
          deal_verified_at?: string | null
          deal_verified_by?: string | null
          id?: string
          intent?: string | null
          journey_stage?: string | null
          last_customer_message_at?: string | null
          last_message_at?: string | null
          last_message_preview?: string | null
          order_id?: string | null
          status?: string
          unread_count?: number
          updated_at?: string
          welcome_sent_at?: string | null
          whatsapp_channel_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_assigned_agent_id_fkey"
            columns: ["assigned_agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_deal_verified_by_fkey"
            columns: ["deal_verified_by"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_whatsapp_channel_id_fkey"
            columns: ["whatsapp_channel_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_channels"
            referencedColumns: ["id"]
          },
        ]
      }
      exchange_rates: {
        Row: {
          fetched_at: string
          rate_date: string
          source: string
          usd_to_ves: number
        }
        Insert: {
          fetched_at?: string
          rate_date: string
          source?: string
          usd_to_ves: number
        }
        Update: {
          fetched_at?: string
          rate_date?: string
          source?: string
          usd_to_ves?: number
        }
        Relationships: []
      }
      familias_motor: {
        Row: {
          codigo_motor: string
          created_at: string
          descripcion: string | null
          id: number
        }
        Insert: {
          codigo_motor: string
          created_at?: string
          descripcion?: string | null
          id?: number
        }
        Update: {
          codigo_motor?: string
          created_at?: string
          descripcion?: string | null
          id?: number
        }
        Relationships: []
      }
      messages: {
        Row: {
          content: string | null
          conversation_id: string
          created_at: string
          direction: string
          id: string
          is_internal_note: boolean
          media_url: string | null
          message_type: string
          reply_to_message_id: string | null
          sender_agent_id: string | null
          sender_type: string
          template_name: string | null
          whatsapp_message_id: string | null
          whatsapp_status: string | null
        }
        Insert: {
          content?: string | null
          conversation_id: string
          created_at?: string
          direction: string
          id?: string
          is_internal_note?: boolean
          media_url?: string | null
          message_type?: string
          reply_to_message_id?: string | null
          sender_agent_id?: string | null
          sender_type: string
          template_name?: string | null
          whatsapp_message_id?: string | null
          whatsapp_status?: string | null
        }
        Update: {
          content?: string | null
          conversation_id?: string
          created_at?: string
          direction?: string
          id?: string
          is_internal_note?: boolean
          media_url?: string | null
          message_type?: string
          reply_to_message_id?: string | null
          sender_agent_id?: string | null
          sender_type?: string
          template_name?: string | null
          whatsapp_message_id?: string | null
          whatsapp_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_reply_to_message_id_fkey"
            columns: ["reply_to_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_sender_agent_id_fkey"
            columns: ["sender_agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      model_pricing: {
        Row: {
          input_price_per_million: number
          model: string
          output_price_per_million: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          input_price_per_million: number
          model: string
          output_price_per_million: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          input_price_per_million?: number
          model?: string
          output_price_per_million?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "model_pricing_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      modelo_motor_nexo: {
        Row: {
          familia_motor_id: number
          modelo_comercial_id: number
        }
        Insert: {
          familia_motor_id: number
          modelo_comercial_id: number
        }
        Update: {
          familia_motor_id?: number
          modelo_comercial_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "modelo_motor_nexo_familia_motor_id_fkey"
            columns: ["familia_motor_id"]
            isOneToOne: false
            referencedRelation: "familias_motor"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "modelo_motor_nexo_modelo_comercial_id_fkey"
            columns: ["modelo_comercial_id"]
            isOneToOne: false
            referencedRelation: "modelos_comerciales"
            referencedColumns: ["id"]
          },
        ]
      }
      modelos_comerciales: {
        Row: {
          anio_desde: number | null
          anio_hasta: number | null
          created_at: string
          id: number
          marca: string
          modelo: string
        }
        Insert: {
          anio_desde?: number | null
          anio_hasta?: number | null
          created_at?: string
          id?: number
          marca: string
          modelo: string
        }
        Update: {
          anio_desde?: number | null
          anio_hasta?: number | null
          created_at?: string
          id?: number
          marca?: string
          modelo?: string
        }
        Relationships: []
      }
      notes: {
        Row: {
          agent_id: string | null
          contact_id: string
          content: string
          created_at: string
          id: string
        }
        Insert: {
          agent_id?: string | null
          contact_id: string
          content: string
          created_at?: string
          id?: string
        }
        Update: {
          agent_id?: string | null
          contact_id?: string
          content?: string
          created_at?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notes_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          description: string
          id: string
          order_id: string
          product_id: string | null
          quantity: number
          unit_price: number
        }
        Insert: {
          description: string
          id?: string
          order_id: string
          product_id?: string | null
          quantity?: number
          unit_price: number
        }
        Update: {
          description?: string
          id?: string
          order_id?: string
          product_id?: string | null
          quantity?: number
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          bcv_rate: number | null
          contact_id: string
          created_at: string
          currency: string
          id: string
          purchased_at: string
          total_amount: number
        }
        Insert: {
          bcv_rate?: number | null
          contact_id: string
          created_at?: string
          currency?: string
          id?: string
          purchased_at?: string
          total_amount: number
        }
        Update: {
          bcv_rate?: number | null
          contact_id?: string
          created_at?: string
          currency?: string
          id?: string
          purchased_at?: string
          total_amount?: number
        }
        Relationships: [
          {
            foreignKeyName: "orders_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      product_compatibility: {
        Row: {
          id: string
          moto_brand: string
          moto_model: string
          product_id: string
        }
        Insert: {
          id?: string
          moto_brand: string
          moto_model: string
          product_id: string
        }
        Update: {
          id?: string
          moto_brand?: string
          moto_model?: string
          product_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_compatibility_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          brand: string | null
          created_at: string
          currency: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          price: number
          stock_quantity: number
          updated_at: string
        }
        Insert: {
          brand?: string | null
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          price: number
          stock_quantity?: number
          updated_at?: string
        }
        Update: {
          brand?: string | null
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          price?: number
          stock_quantity?: number
          updated_at?: string
        }
        Relationships: []
      }
      quick_replies: {
        Row: {
          content: string
          created_at: string
          id: string
          label: string
          updated_at: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          label: string
          updated_at?: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          label?: string
          updated_at?: string
        }
        Relationships: []
      }
      rate_limit_hits: {
        Row: {
          bucket: string
          hit_at: string
        }
        Insert: {
          bucket: string
          hit_at?: string
        }
        Update: {
          bucket?: string
          hit_at?: string
        }
        Relationships: []
      }
      repuesto_compatibilidad_modelo: {
        Row: {
          codprod: string
          modelo_comercial_id: number
        }
        Insert: {
          codprod: string
          modelo_comercial_id: number
        }
        Update: {
          codprod?: string
          modelo_comercial_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "repuesto_compatibilidad_modelo_modelo_comercial_id_fkey"
            columns: ["modelo_comercial_id"]
            isOneToOne: false
            referencedRelation: "modelos_comerciales"
            referencedColumns: ["id"]
          },
        ]
      }
      repuesto_compatibilidad_motor: {
        Row: {
          codprod: string
          familia_motor_id: number
        }
        Insert: {
          codprod: string
          familia_motor_id: number
        }
        Update: {
          codprod?: string
          familia_motor_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "repuesto_compatibilidad_motor_familia_motor_id_fkey"
            columns: ["familia_motor_id"]
            isOneToOne: false
            referencedRelation: "familias_motor"
            referencedColumns: ["id"]
          },
        ]
      }
      sinonimos_busqueda: {
        Row: {
          created_at: string
          id: number
          termino_catalogo: string
          termino_jerga: string
        }
        Insert: {
          created_at?: string
          id?: number
          termino_catalogo: string
          termino_jerga: string
        }
        Update: {
          created_at?: string
          id?: number
          termino_catalogo?: string
          termino_jerga?: string
        }
        Relationships: []
      }
      tags: {
        Row: {
          color: string
          created_at: string
          id: string
          label: string
        }
        Insert: {
          color?: string
          created_at?: string
          id?: string
          label: string
        }
        Update: {
          color?: string
          created_at?: string
          id?: string
          label?: string
        }
        Relationships: []
      }
      templates: {
        Row: {
          body_preview: string
          category: string
          created_at: string
          id: string
          language: string
          name: string
          status: string
          whatsapp_channel_id: string | null
        }
        Insert: {
          body_preview: string
          category?: string
          created_at?: string
          id?: string
          language?: string
          name: string
          status?: string
          whatsapp_channel_id?: string | null
        }
        Update: {
          body_preview?: string
          category?: string
          created_at?: string
          id?: string
          language?: string
          name?: string
          status?: string
          whatsapp_channel_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "templates_whatsapp_channel_id_fkey"
            columns: ["whatsapp_channel_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_channels"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_channels: {
        Row: {
          access_token_secret_ref: string | null
          created_at: string
          id: string
          is_active: boolean
          label: string
          phone_number: string
          phone_number_id: string | null
          status: string
          updated_at: string
          waba_id: string | null
        }
        Insert: {
          access_token_secret_ref?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          label: string
          phone_number: string
          phone_number_id?: string | null
          status?: string
          updated_at?: string
          waba_id?: string | null
        }
        Update: {
          access_token_secret_ref?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string
          phone_number?: string
          phone_number_id?: string | null
          status?: string
          updated_at?: string
          waba_id?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      agent_can_run: { Args: never; Returns: boolean }
      agent_spend_today: { Args: never; Returns: number }
      agent_token_usage: {
        Args: { days?: number }
        Returns: {
          day: string
          input_tokens: number
          model: string
          output_tokens: number
          total_tokens: number
        }[]
      }
      is_agent: { Args: never; Returns: boolean }
      is_supervisor_or_admin: { Args: never; Returns: boolean }
      message_activity_by_hour: {
        Args: { from_ts: string; to_ts: string; tz?: string }
        Returns: {
          agent: number
          ai: number
          hour: number
          inbound: number
        }[]
      }
      rate_limit_allow: {
        Args: { p_bucket: string; p_limit: number; p_window_seconds: number }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">
type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]
export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never
export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never
export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never
export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never
export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never
export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
