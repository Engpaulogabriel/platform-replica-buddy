export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      active_sessions: {
        Row: {
          created_at: string
          device_fp: string | null
          fingerprint_mismatch_count: number
          ip: unknown
          last_fingerprint_check: string | null
          last_seen_at: string
          revoked_at: string | null
          session_id: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          device_fp?: string | null
          fingerprint_mismatch_count?: number
          ip?: unknown
          last_fingerprint_check?: string | null
          last_seen_at?: string
          revoked_at?: string | null
          session_id: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          device_fp?: string | null
          fingerprint_mismatch_count?: number
          ip?: unknown
          last_fingerprint_check?: string | null
          last_seen_at?: string
          revoked_at?: string | null
          session_id?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      agent_commands: {
        Row: {
          ack_at: string | null
          created_at: string
          created_by: string | null
          duration_ms: number | null
          error_message: string | null
          executed_at: string | null
          expires_at: string
          farm_id: string
          id: string
          kind: Database["public"]["Enums"]["agent_cmd_kind"]
          payload: Json
          result: Json | null
          status: Database["public"]["Enums"]["agent_cmd_status"]
        }
        Insert: {
          ack_at?: string | null
          created_at?: string
          created_by?: string | null
          duration_ms?: number | null
          error_message?: string | null
          executed_at?: string | null
          expires_at?: string
          farm_id: string
          id?: string
          kind: Database["public"]["Enums"]["agent_cmd_kind"]
          payload?: Json
          result?: Json | null
          status?: Database["public"]["Enums"]["agent_cmd_status"]
        }
        Update: {
          ack_at?: string | null
          created_at?: string
          created_by?: string | null
          duration_ms?: number | null
          error_message?: string | null
          executed_at?: string | null
          expires_at?: string
          farm_id?: string
          id?: string
          kind?: Database["public"]["Enums"]["agent_cmd_kind"]
          payload?: Json
          result?: Json | null
          status?: Database["public"]["Enums"]["agent_cmd_status"]
        }
        Relationships: [
          {
            foreignKeyName: "agent_commands_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_config: {
        Row: {
          created_at: string
          farm_id: string
          id: string
          polling_interval_ms: number
          serial_port: string
          sweep_timeout_ms: number
          tx_gap_ms: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          farm_id: string
          id?: string
          polling_interval_ms?: number
          serial_port?: string
          sweep_timeout_ms?: number
          tx_gap_ms?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          farm_id?: string
          id?: string
          polling_interval_ms?: number
          serial_port?: string
          sweep_timeout_ms?: number
          tx_gap_ms?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_config_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: true
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_credentials: {
        Row: {
          auth_user_id: string
          created_at: string
          email: string
          farm_id: string
          id: string
          last_login_at: string | null
          rotated_at: string | null
        }
        Insert: {
          auth_user_id: string
          created_at?: string
          email: string
          farm_id: string
          id?: string
          last_login_at?: string | null
          rotated_at?: string | null
        }
        Update: {
          auth_user_id?: string
          created_at?: string
          email?: string
          farm_id?: string
          id?: string
          last_login_at?: string | null
          rotated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_credentials_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: true
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_hardware: {
        Row: {
          agent_version: string | null
          alert_level: string
          changed_components: string[]
          farm_id: string
          fingerprint: Json
          last_change_at: string | null
          last_check_at: string
          log_encryption_key: string | null
          registered_at: string
          reset_requested: boolean
          reset_requested_at: string | null
          reset_requested_by: string | null
        }
        Insert: {
          agent_version?: string | null
          alert_level?: string
          changed_components?: string[]
          farm_id: string
          fingerprint?: Json
          last_change_at?: string | null
          last_check_at?: string
          log_encryption_key?: string | null
          registered_at?: string
          reset_requested?: boolean
          reset_requested_at?: string | null
          reset_requested_by?: string | null
        }
        Update: {
          agent_version?: string | null
          alert_level?: string
          changed_components?: string[]
          farm_id?: string
          fingerprint?: Json
          last_change_at?: string | null
          last_check_at?: string
          log_encryption_key?: string | null
          registered_at?: string
          reset_requested?: boolean
          reset_requested_at?: string | null
          reset_requested_by?: string | null
        }
        Relationships: []
      }
      agent_hardware_history: {
        Row: {
          agent_version: string | null
          alert_level: string
          changed_components: string[]
          created_at: string
          current_fingerprint: Json | null
          farm_id: string
          id: string
          previous_fingerprint: Json | null
        }
        Insert: {
          agent_version?: string | null
          alert_level: string
          changed_components?: string[]
          created_at?: string
          current_fingerprint?: Json | null
          farm_id: string
          id?: string
          previous_fingerprint?: Json | null
        }
        Update: {
          agent_version?: string | null
          alert_level?: string
          changed_components?: string[]
          created_at?: string
          current_fingerprint?: Json | null
          farm_id?: string
          id?: string
          previous_fingerprint?: Json | null
        }
        Relationships: []
      }
      agent_logs: {
        Row: {
          category: string
          created_at: string
          farm_id: string
          id: string
          level: string
          message: string
          raw_frame: string | null
        }
        Insert: {
          category: string
          created_at?: string
          farm_id: string
          id?: string
          level: string
          message: string
          raw_frame?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          farm_id?: string
          id?: string
          level?: string
          message?: string
          raw_frame?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_logs_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_releases: {
        Row: {
          artifact_type: string
          created_at: string
          download_url: string | null
          file_hash: string | null
          file_size_bytes: number | null
          id: string
          is_latest: boolean
          mandatory: boolean
          min_version_required: string | null
          published_at: string
          published_by: string | null
          release_notes: string | null
          storage_path: string | null
          version: string
        }
        Insert: {
          artifact_type?: string
          created_at?: string
          download_url?: string | null
          file_hash?: string | null
          file_size_bytes?: number | null
          id?: string
          is_latest?: boolean
          mandatory?: boolean
          min_version_required?: string | null
          published_at?: string
          published_by?: string | null
          release_notes?: string | null
          storage_path?: string | null
          version: string
        }
        Update: {
          artifact_type?: string
          created_at?: string
          download_url?: string | null
          file_hash?: string | null
          file_size_bytes?: number | null
          id?: string
          is_latest?: boolean
          mandatory?: boolean
          min_version_required?: string | null
          published_at?: string
          published_by?: string | null
          release_notes?: string | null
          storage_path?: string | null
          version?: string
        }
        Relationships: []
      }
      agent_update_history: {
        Row: {
          created_at: string
          duration_ms: number | null
          error_message: string | null
          farm_id: string
          from_version: string | null
          id: string
          status: string
          to_version: string
          triggered_by: string | null
        }
        Insert: {
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          farm_id: string
          from_version?: string | null
          id?: string
          status: string
          to_version: string
          triggered_by?: string | null
        }
        Update: {
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          farm_id?: string
          from_version?: string | null
          id?: string
          status?: string
          to_version?: string
          triggered_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_update_history_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_update_status: {
        Row: {
          auto_rollback_detected: boolean
          completed_at: string | null
          current_version: string | null
          download_progress: number
          error_message: string | null
          farm_id: string
          force_update: boolean
          requested_at: string | null
          requested_by: string | null
          started_at: string | null
          target_download_url: string | null
          target_file_hash: string | null
          target_version: string | null
          update_status: string
          updated_at: string
        }
        Insert: {
          auto_rollback_detected?: boolean
          completed_at?: string | null
          current_version?: string | null
          download_progress?: number
          error_message?: string | null
          farm_id: string
          force_update?: boolean
          requested_at?: string | null
          requested_by?: string | null
          started_at?: string | null
          target_download_url?: string | null
          target_file_hash?: string | null
          target_version?: string | null
          update_status?: string
          updated_at?: string
        }
        Update: {
          auto_rollback_detected?: boolean
          completed_at?: string | null
          current_version?: string | null
          download_progress?: number
          error_message?: string | null
          farm_id?: string
          force_update?: boolean
          requested_at?: string | null
          requested_by?: string | null
          started_at?: string | null
          target_download_url?: string | null
          target_file_hash?: string | null
          target_version?: string | null
          update_status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_update_status_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: true
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_classification_log: {
        Row: {
          ai_confidence: number | null
          ai_equipments: string[] | null
          ai_full_response: Json | null
          ai_intent: string | null
          canonical_command: string | null
          created_at: string
          execution_time_ms: number | null
          fallback_used: boolean
          farm_id: string | null
          feedback_for_log_id: string | null
          feedback_type: string | null
          id: string
          operator_correction: string | null
          operator_phone: string
          raw_message: string
          tokens_input: number | null
          tokens_output: number | null
          was_correct: boolean | null
        }
        Insert: {
          ai_confidence?: number | null
          ai_equipments?: string[] | null
          ai_full_response?: Json | null
          ai_intent?: string | null
          canonical_command?: string | null
          created_at?: string
          execution_time_ms?: number | null
          fallback_used?: boolean
          farm_id?: string | null
          feedback_for_log_id?: string | null
          feedback_type?: string | null
          id?: string
          operator_correction?: string | null
          operator_phone: string
          raw_message: string
          tokens_input?: number | null
          tokens_output?: number | null
          was_correct?: boolean | null
        }
        Update: {
          ai_confidence?: number | null
          ai_equipments?: string[] | null
          ai_full_response?: Json | null
          ai_intent?: string | null
          canonical_command?: string | null
          created_at?: string
          execution_time_ms?: number | null
          fallback_used?: boolean
          farm_id?: string | null
          feedback_for_log_id?: string | null
          feedback_type?: string | null
          id?: string
          operator_correction?: string | null
          operator_phone?: string
          raw_message?: string
          tokens_input?: number | null
          tokens_output?: number | null
          was_correct?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_classification_log_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_classification_log_feedback_for_log_id_fkey"
            columns: ["feedback_for_log_id"]
            isOneToOne: false
            referencedRelation: "ai_classification_log"
            referencedColumns: ["id"]
          },
        ]
      }
      api_hits: {
        Row: {
          created_at: string
          endpoint: string
          id: string
          ip_address: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          endpoint: string
          id?: string
          ip_address?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          endpoint?: string
          id?: string
          ip_address?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      authorized_devices: {
        Row: {
          browser: string | null
          device_fingerprint: string
          device_name: string | null
          device_type: string | null
          farm_id: string | null
          id: string
          is_active: boolean
          last_used_at: string
          os: string | null
          registered_at: string
          registered_by: string | null
          user_id: string
        }
        Insert: {
          browser?: string | null
          device_fingerprint: string
          device_name?: string | null
          device_type?: string | null
          farm_id?: string | null
          id?: string
          is_active?: boolean
          last_used_at?: string
          os?: string | null
          registered_at?: string
          registered_by?: string | null
          user_id: string
        }
        Update: {
          browser?: string | null
          device_fingerprint?: string
          device_name?: string | null
          device_type?: string | null
          farm_id?: string | null
          id?: string
          is_active?: boolean
          last_used_at?: string
          os?: string | null
          registered_at?: string
          registered_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "authorized_devices_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_actions: {
        Row: {
          action: string
          automation_id: string
          created_at: string
          equipment_ids: Json
          id: string
          order: number
        }
        Insert: {
          action: string
          automation_id: string
          created_at?: string
          equipment_ids?: Json
          id?: string
          order?: number
        }
        Update: {
          action?: string
          automation_id?: string
          created_at?: string
          equipment_ids?: Json
          id?: string
          order?: number
        }
        Relationships: [
          {
            foreignKeyName: "automation_actions_automation_id_fkey"
            columns: ["automation_id"]
            isOneToOne: false
            referencedRelation: "automations"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_audit_log: {
        Row: {
          action: string | null
          actual_execution_time: string | null
          automation_id: string | null
          changed_by_role: string | null
          created_at: string
          equipment_ids: Json
          event_type: string
          farm_id: string
          id: string
          notes: string | null
          performed_by_email: string | null
          performed_by_name: string | null
          performed_by_phone: string | null
          performed_via: string
          result_details: Json
          scheduled_time: string | null
          trigger_type: string | null
        }
        Insert: {
          action?: string | null
          actual_execution_time?: string | null
          automation_id?: string | null
          changed_by_role?: string | null
          created_at?: string
          equipment_ids?: Json
          event_type: string
          farm_id: string
          id?: string
          notes?: string | null
          performed_by_email?: string | null
          performed_by_name?: string | null
          performed_by_phone?: string | null
          performed_via: string
          result_details?: Json
          scheduled_time?: string | null
          trigger_type?: string | null
        }
        Update: {
          action?: string | null
          actual_execution_time?: string | null
          automation_id?: string | null
          changed_by_role?: string | null
          created_at?: string
          equipment_ids?: Json
          event_type?: string
          farm_id?: string
          id?: string
          notes?: string | null
          performed_by_email?: string | null
          performed_by_name?: string | null
          performed_by_phone?: string | null
          performed_via?: string
          result_details?: Json
          scheduled_time?: string | null
          trigger_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "automation_audit_log_automation_id_fkey"
            columns: ["automation_id"]
            isOneToOne: false
            referencedRelation: "automations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_audit_log_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_engine: {
        Row: {
          enabled: boolean
          farm_id: string
          last_changed_by: string | null
          last_changed_via: string | null
          updated_at: string
        }
        Insert: {
          enabled?: boolean
          farm_id: string
          last_changed_by?: string | null
          last_changed_via?: string | null
          updated_at?: string
        }
        Update: {
          enabled?: boolean
          farm_id?: string
          last_changed_by?: string | null
          last_changed_via?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_engine_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: true
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_execution_history: {
        Row: {
          actions_executed: Json
          all_success: boolean
          automation_id: string
          automation_name: string | null
          created_at: string
          expected_states: Json | null
          farm_id: string | null
          id: string
          notification_sent: boolean
          trigger_id: string | null
          triggered_at: string
          verification_pending: boolean
          verified_at: string | null
        }
        Insert: {
          actions_executed?: Json
          all_success?: boolean
          automation_id: string
          automation_name?: string | null
          created_at?: string
          expected_states?: Json | null
          farm_id?: string | null
          id?: string
          notification_sent?: boolean
          trigger_id?: string | null
          triggered_at?: string
          verification_pending?: boolean
          verified_at?: string | null
        }
        Update: {
          actions_executed?: Json
          all_success?: boolean
          automation_id?: string
          automation_name?: string | null
          created_at?: string
          expected_states?: Json | null
          farm_id?: string | null
          id?: string
          notification_sent?: boolean
          trigger_id?: string | null
          triggered_at?: string
          verification_pending?: boolean
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "automation_execution_history_automation_id_fkey"
            columns: ["automation_id"]
            isOneToOne: false
            referencedRelation: "automations"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_execution_log: {
        Row: {
          action: string
          created_at: string
          details: Json | null
          equipment_id: string | null
          executed_at: string
          failure_reason: string | null
          farm_id: string
          id: string
          notified_at: string | null
          origin: string
          schedule_id: string | null
          scheduled_time: string | null
          status: string
        }
        Insert: {
          action: string
          created_at?: string
          details?: Json | null
          equipment_id?: string | null
          executed_at?: string
          failure_reason?: string | null
          farm_id: string
          id?: string
          notified_at?: string | null
          origin?: string
          schedule_id?: string | null
          scheduled_time?: string | null
          status?: string
        }
        Update: {
          action?: string
          created_at?: string
          details?: Json | null
          equipment_id?: string | null
          executed_at?: string
          failure_reason?: string | null
          farm_id?: string
          id?: string
          notified_at?: string | null
          origin?: string
          schedule_id?: string | null
          scheduled_time?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_execution_log_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_execution_log_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_execution_log_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "automation_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_fired: {
        Row: {
          fired_at: string
          fired_key: string
          schedule_id: string
        }
        Insert: {
          fired_at?: string
          fired_key: string
          schedule_id: string
        }
        Update: {
          fired_at?: string
          fired_key?: string
          schedule_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_fired_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "automation_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_guards: {
        Row: {
          created_at: string
          equipment_id: string
          farm_id: string
          id: string
          pump_name: string
          silenced_schedule_ids: string[]
          triggered_at: string
        }
        Insert: {
          created_at?: string
          equipment_id: string
          farm_id: string
          id?: string
          pump_name: string
          silenced_schedule_ids?: string[]
          triggered_at?: string
        }
        Update: {
          created_at?: string
          equipment_id?: string
          farm_id?: string
          id?: string
          pump_name?: string
          silenced_schedule_ids?: string[]
          triggered_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_guards_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_guards_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_holiday_configs: {
        Row: {
          created_at: string
          enabled: boolean
          equipment_id: string
          farm_id: string
          id: string
          mode: string
          special_time_off: string
          special_time_on: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          equipment_id: string
          farm_id: string
          id?: string
          mode?: string
          special_time_off?: string
          special_time_on?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          equipment_id?: string
          farm_id?: string
          id?: string
          mode?: string
          special_time_off?: string
          special_time_on?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_holiday_configs_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_holiday_configs_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_log: {
        Row: {
          action: Database["public"]["Enums"]["event_action"]
          actor_label: string | null
          client_event_id: string | null
          created_at: string
          details: Json | null
          equipment_id: string | null
          equipment_name: string
          farm_id: string
          id: string
          new_state: string | null
          occurred_at: string
          origin: Database["public"]["Enums"]["event_origin"]
          result: Database["public"]["Enums"]["event_result"]
          source_device: string | null
          user_email: string | null
          user_id: string | null
        }
        Insert: {
          action: Database["public"]["Enums"]["event_action"]
          actor_label?: string | null
          client_event_id?: string | null
          created_at?: string
          details?: Json | null
          equipment_id?: string | null
          equipment_name: string
          farm_id: string
          id?: string
          new_state?: string | null
          occurred_at?: string
          origin: Database["public"]["Enums"]["event_origin"]
          result?: Database["public"]["Enums"]["event_result"]
          source_device?: string | null
          user_email?: string | null
          user_id?: string | null
        }
        Update: {
          action?: Database["public"]["Enums"]["event_action"]
          actor_label?: string | null
          client_event_id?: string | null
          created_at?: string
          details?: Json | null
          equipment_id?: string | null
          equipment_name?: string
          farm_id?: string
          id?: string
          new_state?: string | null
          occurred_at?: string
          origin?: Database["public"]["Enums"]["event_origin"]
          result?: Database["public"]["Enums"]["event_result"]
          source_device?: string | null
          user_email?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "automation_log_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_log_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_schedules: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          created_by_name: string | null
          created_by_via: string | null
          days: string[]
          equipment_id: string
          farm_id: string
          id: string
          last_modified_by_name: string | null
          last_modified_by_via: string | null
          last_off_executed_at: string | null
          last_on_executed_at: string | null
          last_toggled_by: string | null
          last_toggled_via: string | null
          mode: string
          time_off: string
          time_on: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          created_by_via?: string | null
          days?: string[]
          equipment_id: string
          farm_id: string
          id?: string
          last_modified_by_name?: string | null
          last_modified_by_via?: string | null
          last_off_executed_at?: string | null
          last_on_executed_at?: string | null
          last_toggled_by?: string | null
          last_toggled_via?: string | null
          mode?: string
          time_off: string
          time_on: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          created_by_via?: string | null
          days?: string[]
          equipment_id?: string
          farm_id?: string
          id?: string
          last_modified_by_name?: string | null
          last_modified_by_via?: string | null
          last_off_executed_at?: string | null
          last_on_executed_at?: string | null
          last_toggled_by?: string | null
          last_toggled_via?: string | null
          mode?: string
          time_off?: string
          time_on?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_schedules_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_schedules_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_schedules_audit: {
        Row: {
          action: string
          created_at: string
          equipment_id: string | null
          farm_id: string
          id: string
          new_values: Json | null
          old_values: Json | null
          performed_by: string | null
          performed_via: string | null
          schedule_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          equipment_id?: string | null
          farm_id: string
          id?: string
          new_values?: Json | null
          old_values?: Json | null
          performed_by?: string | null
          performed_via?: string | null
          schedule_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          equipment_id?: string | null
          farm_id?: string
          id?: string
          new_values?: Json | null
          old_values?: Json | null
          performed_by?: string | null
          performed_via?: string | null
          schedule_id?: string | null
        }
        Relationships: []
      }
      automation_tick_logs: {
        Row: {
          commands_inserted: number
          details: Json
          executed_at: string
          id: string
          schedules_found: number
        }
        Insert: {
          commands_inserted?: number
          details?: Json
          executed_at?: string
          id?: string
          schedules_found?: number
        }
        Update: {
          commands_inserted?: number
          details?: Json
          executed_at?: string
          id?: string
          schedules_found?: number
        }
        Relationships: []
      }
      automation_triggers: {
        Row: {
          automation_id: string
          condition_type: string | null
          condition_value: string | null
          created_at: string
          days: Json | null
          delay_minutes: number | null
          execute_once: boolean
          id: string
          last_executed_at: string | null
          scheduled_for: string | null
          time_value: string | null
          trigger_type: string
        }
        Insert: {
          automation_id: string
          condition_type?: string | null
          condition_value?: string | null
          created_at?: string
          days?: Json | null
          delay_minutes?: number | null
          execute_once?: boolean
          id?: string
          last_executed_at?: string | null
          scheduled_for?: string | null
          time_value?: string | null
          trigger_type: string
        }
        Update: {
          automation_id?: string
          condition_type?: string | null
          condition_value?: string | null
          created_at?: string
          days?: Json | null
          delay_minutes?: number | null
          execute_once?: boolean
          id?: string
          last_executed_at?: string | null
          scheduled_for?: string | null
          time_value?: string | null
          trigger_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_triggers_automation_id_fkey"
            columns: ["automation_id"]
            isOneToOne: false
            referencedRelation: "automations"
            referencedColumns: ["id"]
          },
        ]
      }
      automations: {
        Row: {
          created_at: string
          created_by: string | null
          created_via: string
          farm_id: string
          id: string
          is_active: boolean
          name: string
          type: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          created_via?: string
          farm_id: string
          id?: string
          is_active?: boolean
          name: string
          type: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          created_via?: string
          farm_id?: string
          id?: string
          is_active?: boolean
          name?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "automations_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      bridge_heartbeat: {
        Row: {
          bridge_name: string
          created_at: string
          electron_version: string | null
          farm_id: string
          id: string
          ip_address: string | null
          last_heartbeat_at: string
          status: string
          updated_at: string
          uptime_seconds: number | null
        }
        Insert: {
          bridge_name?: string
          created_at?: string
          electron_version?: string | null
          farm_id: string
          id?: string
          ip_address?: string | null
          last_heartbeat_at?: string
          status?: string
          updated_at?: string
          uptime_seconds?: number | null
        }
        Update: {
          bridge_name?: string
          created_at?: string
          electron_version?: string | null
          farm_id?: string
          id?: string
          ip_address?: string | null
          last_heartbeat_at?: string
          status?: string
          updated_at?: string
          uptime_seconds?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "bridge_heartbeat_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      bridge_heartbeat_log: {
        Row: {
          alerted_at: string
          details: string | null
          event_type: string
          farm_id: string | null
          id: string
        }
        Insert: {
          alerted_at?: string
          details?: string | null
          event_type: string
          farm_id?: string | null
          id?: string
        }
        Update: {
          alerted_at?: string
          details?: string | null
          event_type?: string
          farm_id?: string | null
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bridge_heartbeat_log_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      command_verifications: {
        Row: {
          command_sent_at: string
          created_at: string
          equipment_id: string | null
          equipment_name: string | null
          expected_state: string
          farm_id: string | null
          id: string
          operator_phone: string | null
          result: string | null
          verified_at: string | null
        }
        Insert: {
          command_sent_at?: string
          created_at?: string
          equipment_id?: string | null
          equipment_name?: string | null
          expected_state: string
          farm_id?: string | null
          id?: string
          operator_phone?: string | null
          result?: string | null
          verified_at?: string | null
        }
        Update: {
          command_sent_at?: string
          created_at?: string
          equipment_id?: string | null
          equipment_name?: string | null
          expected_state?: string
          farm_id?: string | null
          id?: string
          operator_phone?: string | null
          result?: string | null
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "command_verifications_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "command_verifications_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      commands: {
        Row: {
          client_event_id: string
          created_at: string
          created_by: string | null
          equipment_id: string | null
          error_message: string | null
          farm_id: string
          frame: string
          id: string
          plc_hw_id: string | null
          priority: number
          reinforcement: boolean
          responded_at: string | null
          response: string | null
          retry_count: number
          sent_at: string | null
          source_device: string | null
          status: Database["public"]["Enums"]["command_status"]
          timeout_ms: number
          type: Database["public"]["Enums"]["command_type"]
        }
        Insert: {
          client_event_id?: string
          created_at?: string
          created_by?: string | null
          equipment_id?: string | null
          error_message?: string | null
          farm_id: string
          frame: string
          id?: string
          plc_hw_id?: string | null
          priority?: number
          reinforcement?: boolean
          responded_at?: string | null
          response?: string | null
          retry_count?: number
          sent_at?: string | null
          source_device?: string | null
          status?: Database["public"]["Enums"]["command_status"]
          timeout_ms?: number
          type: Database["public"]["Enums"]["command_type"]
        }
        Update: {
          client_event_id?: string
          created_at?: string
          created_by?: string | null
          equipment_id?: string | null
          error_message?: string | null
          farm_id?: string
          frame?: string
          id?: string
          plc_hw_id?: string | null
          priority?: number
          reinforcement?: boolean
          responded_at?: string | null
          response?: string | null
          retry_count?: number
          sent_at?: string | null
          source_device?: string | null
          status?: Database["public"]["Enums"]["command_status"]
          timeout_ms?: number
          type?: Database["public"]["Enums"]["command_type"]
        }
        Relationships: []
      }
      daily_consumption: {
        Row: {
          created_at: string
          date: string
          equipment_id: string
          farm_id: string
          id: string
          mode: string
          total_m3: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          date: string
          equipment_id: string
          farm_id: string
          id?: string
          mode?: string
          total_m3?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          date?: string
          equipment_id?: string
          farm_id?: string
          id?: string
          mode?: string
          total_m3?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_consumption_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_consumption_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      dashboard_layouts: {
        Row: {
          farm_id: string
          layout: Json
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          farm_id: string
          layout?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          farm_id?: string
          layout?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dashboard_layouts_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: true
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      device_access_attempts: {
        Row: {
          attempted_at: string
          device_fingerprint: string
          device_info: Json
          id: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          user_id: string | null
        }
        Insert: {
          attempted_at?: string
          device_fingerprint: string
          device_info?: Json
          id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          user_id?: string | null
        }
        Update: {
          attempted_at?: string
          device_fingerprint?: string
          device_info?: Json
          id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          user_id?: string | null
        }
        Relationships: []
      }
      device_audit_log: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          details: Json
          device_id: string | null
          farm_id: string | null
          id: string
          target_user_id: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          details?: Json
          device_id?: string | null
          farm_id?: string | null
          id?: string
          target_user_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          details?: Json
          device_id?: string | null
          farm_id?: string | null
          id?: string
          target_user_id?: string | null
        }
        Relationships: []
      }
      device_licenses: {
        Row: {
          activated_at: string
          agent_version: string | null
          created_at: string
          current_token_jti: string | null
          farm_id: string
          fingerprint: Json
          id: string
          ip_address: string | null
          last_seen_at: string
          license_key: string
          machine_id_hash: string
          revoked_at: string | null
          revoked_reason: string | null
          updated_at: string
        }
        Insert: {
          activated_at?: string
          agent_version?: string | null
          created_at?: string
          current_token_jti?: string | null
          farm_id: string
          fingerprint?: Json
          id?: string
          ip_address?: string | null
          last_seen_at?: string
          license_key: string
          machine_id_hash: string
          revoked_at?: string | null
          revoked_reason?: string | null
          updated_at?: string
        }
        Update: {
          activated_at?: string
          agent_version?: string | null
          created_at?: string
          current_token_jti?: string | null
          farm_id?: string
          fingerprint?: Json
          id?: string
          ip_address?: string | null
          last_seen_at?: string
          license_key?: string
          machine_id_hash?: string
          revoked_at?: string | null
          revoked_reason?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_licenses_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      device_register_links: {
        Row: {
          consumed_at: string | null
          consumed_device_id: string | null
          created_at: string
          created_by: string
          device_name: string | null
          expires_at: string
          target_user_id: string
          token: string
        }
        Insert: {
          consumed_at?: string | null
          consumed_device_id?: string | null
          created_at?: string
          created_by: string
          device_name?: string | null
          expires_at?: string
          target_user_id: string
          token: string
        }
        Update: {
          consumed_at?: string | null
          consumed_device_id?: string | null
          created_at?: string
          created_by?: string
          device_name?: string | null
          expires_at?: string
          target_user_id?: string
          token?: string
        }
        Relationships: []
      }
      energy_efficiency_daily: {
        Row: {
          created_at: string
          cycle_date: string | null
          date: string
          efficiency_percent: number
          farm_id: string
          gap_pump_minutes: number
          id: string
          is_free_demand: boolean
          lost_minutes: number
          lost_pump_minutes: number
          minutes_on_during_peak: number
          peak_pump_minutes: number
          post_lost_pump_minutes: number
          post_peak_ok_count: number
          post_peak_startup_time: string | null
          pre_lost_pump_minutes: number
          pre_peak_ok_count: number
          pre_peak_shutdown_time: string | null
          pumps_on_during_peak: number
          pumps_operated: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          cycle_date?: string | null
          date: string
          efficiency_percent?: number
          farm_id: string
          gap_pump_minutes?: number
          id?: string
          is_free_demand?: boolean
          lost_minutes?: number
          lost_pump_minutes?: number
          minutes_on_during_peak?: number
          peak_pump_minutes?: number
          post_lost_pump_minutes?: number
          post_peak_ok_count?: number
          post_peak_startup_time?: string | null
          pre_lost_pump_minutes?: number
          pre_peak_ok_count?: number
          pre_peak_shutdown_time?: string | null
          pumps_on_during_peak?: number
          pumps_operated?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          cycle_date?: string | null
          date?: string
          efficiency_percent?: number
          farm_id?: string
          gap_pump_minutes?: number
          id?: string
          is_free_demand?: boolean
          lost_minutes?: number
          lost_pump_minutes?: number
          minutes_on_during_peak?: number
          peak_pump_minutes?: number
          post_lost_pump_minutes?: number
          post_peak_ok_count?: number
          post_peak_startup_time?: string | null
          pre_lost_pump_minutes?: number
          pre_peak_ok_count?: number
          pre_peak_shutdown_time?: string | null
          pumps_on_during_peak?: number
          pumps_operated?: number
          updated_at?: string
        }
        Relationships: []
      }
      energy_efficiency_daily_pumps: {
        Row: {
          created_at: string
          date: string
          early_off_min: number
          equipment_id: string
          equipment_name: string
          farm_id: string
          first_on: string | null
          id: string
          last_off: string | null
          late_min: number
          mode: string
          peak_minutes: number
          peak_violation: boolean
          post_status: string
          pre_status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          date: string
          early_off_min?: number
          equipment_id: string
          equipment_name: string
          farm_id: string
          first_on?: string | null
          id?: string
          last_off?: string | null
          late_min?: number
          mode?: string
          peak_minutes?: number
          peak_violation?: boolean
          post_status?: string
          pre_status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          date?: string
          early_off_min?: number
          equipment_id?: string
          equipment_name?: string
          farm_id?: string
          first_on?: string | null
          id?: string
          last_off?: string | null
          late_min?: number
          mode?: string
          peak_minutes?: number
          peak_violation?: boolean
          post_status?: string
          pre_status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "energy_efficiency_daily_pumps_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      equipments: {
        Row: {
          active: boolean
          alarm_high: number | null
          alarm_low: number | null
          alimenta_id: string | null
          auto_mode: boolean
          command_blocked_until: string | null
          communication_status: string
          created_at: string
          demanda_kw: number | null
          desired_running: boolean
          estimated_flow_m3h: number | null
          farm_id: string
          firmware_version: string | null
          flow_accum_at: string | null
          flow_accum_m3: number | null
          flow_daily_start_at: string | null
          flow_daily_start_m3: number | null
          flow_rate_m3h: number
          flow_total_m3: number
          fonte_id: string | null
          fonte_tipo: string | null
          horas_pico: string | null
          hw_id: string
          id: string
          last_actuation_origin: string | null
          last_changed_by: string | null
          last_communication: string | null
          last_confirmed_state: number
          last_outputs_state: string | null
          last_polling_at: string | null
          last_signal_bars: number | null
          latitude: number | null
          level_cal_digital: number | null
          level_cal_meters: number | null
          level_last_raw: number | null
          level_last_raw_at: string | null
          level_max_meters: number | null
          level_sensor_index: number | null
          local_ack_at: string | null
          longitude: number | null
          maintenance_mode: boolean
          maintenance_reason: string | null
          maintenance_started_at: string | null
          maintenance_started_by: string | null
          maintenance_started_via: string | null
          max_height: number | null
          max_horas_dia: number | null
          name: string
          outorga_vazao_max_m3h: number | null
          outorga_volume_max_mensal_m3: number | null
          participates_night_cycle: boolean
          pending_command_id: string | null
          plc_group_id: string | null
          polling_interval_seconds: number
          power_cv: number | null
          power_kw: number | null
          rf_radio: string | null
          rf_via_rep: boolean | null
          runtime_checkpoint_at: string | null
          safety_expired_at: string | null
          saida: number | null
          sector_id: string | null
          telemetry_interval: number
          type: Database["public"]["Enums"]["equipment_type"]
          updated_at: string
          vazao_cadastrada_m3h: number
          vazao_m3_por_pulso: number | null
          vazao_mode: string
          vazao_reset_pending: boolean
        }
        Insert: {
          active?: boolean
          alarm_high?: number | null
          alarm_low?: number | null
          alimenta_id?: string | null
          auto_mode?: boolean
          command_blocked_until?: string | null
          communication_status?: string
          created_at?: string
          demanda_kw?: number | null
          desired_running?: boolean
          estimated_flow_m3h?: number | null
          farm_id: string
          firmware_version?: string | null
          flow_accum_at?: string | null
          flow_accum_m3?: number | null
          flow_daily_start_at?: string | null
          flow_daily_start_m3?: number | null
          flow_rate_m3h?: number
          flow_total_m3?: number
          fonte_id?: string | null
          fonte_tipo?: string | null
          horas_pico?: string | null
          hw_id: string
          id?: string
          last_actuation_origin?: string | null
          last_changed_by?: string | null
          last_communication?: string | null
          last_confirmed_state?: number
          last_outputs_state?: string | null
          last_polling_at?: string | null
          last_signal_bars?: number | null
          latitude?: number | null
          level_cal_digital?: number | null
          level_cal_meters?: number | null
          level_last_raw?: number | null
          level_last_raw_at?: string | null
          level_max_meters?: number | null
          level_sensor_index?: number | null
          local_ack_at?: string | null
          longitude?: number | null
          maintenance_mode?: boolean
          maintenance_reason?: string | null
          maintenance_started_at?: string | null
          maintenance_started_by?: string | null
          maintenance_started_via?: string | null
          max_height?: number | null
          max_horas_dia?: number | null
          name: string
          outorga_vazao_max_m3h?: number | null
          outorga_volume_max_mensal_m3?: number | null
          participates_night_cycle?: boolean
          pending_command_id?: string | null
          plc_group_id?: string | null
          polling_interval_seconds?: number
          power_cv?: number | null
          power_kw?: number | null
          rf_radio?: string | null
          rf_via_rep?: boolean | null
          runtime_checkpoint_at?: string | null
          safety_expired_at?: string | null
          saida?: number | null
          sector_id?: string | null
          telemetry_interval?: number
          type: Database["public"]["Enums"]["equipment_type"]
          updated_at?: string
          vazao_cadastrada_m3h?: number
          vazao_m3_por_pulso?: number | null
          vazao_mode?: string
          vazao_reset_pending?: boolean
        }
        Update: {
          active?: boolean
          alarm_high?: number | null
          alarm_low?: number | null
          alimenta_id?: string | null
          auto_mode?: boolean
          command_blocked_until?: string | null
          communication_status?: string
          created_at?: string
          demanda_kw?: number | null
          desired_running?: boolean
          estimated_flow_m3h?: number | null
          farm_id?: string
          firmware_version?: string | null
          flow_accum_at?: string | null
          flow_accum_m3?: number | null
          flow_daily_start_at?: string | null
          flow_daily_start_m3?: number | null
          flow_rate_m3h?: number
          flow_total_m3?: number
          fonte_id?: string | null
          fonte_tipo?: string | null
          horas_pico?: string | null
          hw_id?: string
          id?: string
          last_actuation_origin?: string | null
          last_changed_by?: string | null
          last_communication?: string | null
          last_confirmed_state?: number
          last_outputs_state?: string | null
          last_polling_at?: string | null
          last_signal_bars?: number | null
          latitude?: number | null
          level_cal_digital?: number | null
          level_cal_meters?: number | null
          level_last_raw?: number | null
          level_last_raw_at?: string | null
          level_max_meters?: number | null
          level_sensor_index?: number | null
          local_ack_at?: string | null
          longitude?: number | null
          maintenance_mode?: boolean
          maintenance_reason?: string | null
          maintenance_started_at?: string | null
          maintenance_started_by?: string | null
          maintenance_started_via?: string | null
          max_height?: number | null
          max_horas_dia?: number | null
          name?: string
          outorga_vazao_max_m3h?: number | null
          outorga_volume_max_mensal_m3?: number | null
          participates_night_cycle?: boolean
          pending_command_id?: string | null
          plc_group_id?: string | null
          polling_interval_seconds?: number
          power_cv?: number | null
          power_kw?: number | null
          rf_radio?: string | null
          rf_via_rep?: boolean | null
          runtime_checkpoint_at?: string | null
          safety_expired_at?: string | null
          saida?: number | null
          sector_id?: string | null
          telemetry_interval?: number
          type?: Database["public"]["Enums"]["equipment_type"]
          updated_at?: string
          vazao_cadastrada_m3h?: number
          vazao_m3_por_pulso?: number | null
          vazao_mode?: string
          vazao_reset_pending?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "equipments_alimenta_fk"
            columns: ["alimenta_id"]
            isOneToOne: false
            referencedRelation: "equipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "equipments_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "equipments_fonte_id_fkey"
            columns: ["fonte_id"]
            isOneToOne: false
            referencedRelation: "equipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "equipments_plc_group_fk"
            columns: ["plc_group_id"]
            isOneToOne: false
            referencedRelation: "plc_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "equipments_sector_fk"
            columns: ["sector_id"]
            isOneToOne: false
            referencedRelation: "sectors"
            referencedColumns: ["id"]
          },
        ]
      }
      farm_access_requests: {
        Row: {
          browser: string | null
          created_at: string | null
          farm_id: string
          id: string
          ip_address: string
          os: string | null
          platform: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string | null
          user_agent: string | null
          user_email: string
          user_id: string | null
        }
        Insert: {
          browser?: string | null
          created_at?: string | null
          farm_id: string
          id?: string
          ip_address: string
          os?: string | null
          platform?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string | null
          user_agent?: string | null
          user_email: string
          user_id?: string | null
        }
        Update: {
          browser?: string | null
          created_at?: string | null
          farm_id?: string
          id?: string
          ip_address?: string
          os?: string | null
          platform?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string | null
          user_agent?: string | null
          user_email?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "farm_access_requests_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      farm_allowed_ips: {
        Row: {
          created_at: string
          created_by: string | null
          description: string
          farm_id: string
          id: string
          ip_address: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string
          farm_id: string
          id?: string
          ip_address: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string
          farm_id?: string
          id?: string
          ip_address?: string
        }
        Relationships: [
          {
            foreignKeyName: "farm_allowed_ips_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      farm_approved_devices: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          browser: string | null
          description: string | null
          farm_id: string
          id: string
          ip_address: string
          os: string | null
          platform: string | null
          user_agent: string | null
          user_email: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          browser?: string | null
          description?: string | null
          farm_id: string
          id?: string
          ip_address: string
          os?: string | null
          platform?: string | null
          user_agent?: string | null
          user_email?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          browser?: string | null
          description?: string | null
          farm_id?: string
          id?: string
          ip_address?: string
          os?: string | null
          platform?: string | null
          user_agent?: string | null
          user_email?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "farm_approved_devices_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      farm_backups: {
        Row: {
          automacao: Json
          cadastros: Json
          created_at: string
          created_by: string | null
          farm_id: string
          historico: Json
          id: string
          label: string | null
          meta: Json
          size_bytes: number | null
          trigger_kind: string
          usuarios: Json
        }
        Insert: {
          automacao?: Json
          cadastros?: Json
          created_at?: string
          created_by?: string | null
          farm_id: string
          historico?: Json
          id?: string
          label?: string | null
          meta?: Json
          size_bytes?: number | null
          trigger_kind?: string
          usuarios?: Json
        }
        Update: {
          automacao?: Json
          cadastros?: Json
          created_at?: string
          created_by?: string | null
          farm_id?: string
          historico?: Json
          id?: string
          label?: string | null
          meta?: Json
          size_bytes?: number | null
          trigger_kind?: string
          usuarios?: Json
        }
        Relationships: []
      }
      farm_inema_config: {
        Row: {
          farm_id: string
          observacoes: string | null
          orgao: string | null
          outorga_numero: string | null
          outorga_processo: string | null
          outorga_validade: string | null
          responsavel_tecnico: string | null
          updated_at: string
          updated_by: string | null
          vazao_outorgada_m3h: number | null
        }
        Insert: {
          farm_id: string
          observacoes?: string | null
          orgao?: string | null
          outorga_numero?: string | null
          outorga_processo?: string | null
          outorga_validade?: string | null
          responsavel_tecnico?: string | null
          updated_at?: string
          updated_by?: string | null
          vazao_outorgada_m3h?: number | null
        }
        Update: {
          farm_id?: string
          observacoes?: string | null
          orgao?: string | null
          outorga_numero?: string | null
          outorga_processo?: string | null
          outorga_validade?: string | null
          responsavel_tecnico?: string | null
          updated_at?: string
          updated_by?: string | null
          vazao_outorgada_m3h?: number | null
        }
        Relationships: []
      }
      farm_maintenance_locks: {
        Row: {
          activated_at: string
          activated_by: string | null
          expires_at: string
          farm_id: string
          reason: string | null
          updated_at: string
        }
        Insert: {
          activated_at?: string
          activated_by?: string | null
          expires_at: string
          farm_id: string
          reason?: string | null
          updated_at?: string
        }
        Update: {
          activated_at?: string
          activated_by?: string | null
          expires_at?: string
          farm_id?: string
          reason?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      farm_messages: {
        Row: {
          body: string
          created_at: string
          created_by: string | null
          dismissed_by: Json
          expires_at: string | null
          farm_id: string
          id: string
          level: string
          title: string
        }
        Insert: {
          body: string
          created_at?: string
          created_by?: string | null
          dismissed_by?: Json
          expires_at?: string | null
          farm_id: string
          id?: string
          level?: string
          title: string
        }
        Update: {
          body?: string
          created_at?: string
          created_by?: string | null
          dismissed_by?: Json
          expires_at?: string | null
          farm_id?: string
          id?: string
          level?: string
          title?: string
        }
        Relationships: []
      }
      farm_notification_reads: {
        Row: {
          notification_id: string
          read_at: string
          user_id: string
        }
        Insert: {
          notification_id: string
          read_at?: string
          user_id: string
        }
        Update: {
          notification_id?: string
          read_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "farm_notification_reads_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "farm_notifications"
            referencedColumns: ["id"]
          },
        ]
      }
      farm_notifications: {
        Row: {
          created_at: string
          equipment_id: string | null
          farm_id: string
          id: string
          kind: string
          message: string
          resolved_at: string | null
          severity: string
          source: string | null
          source_ref: string | null
          title: string
        }
        Insert: {
          created_at?: string
          equipment_id?: string | null
          farm_id: string
          id?: string
          kind?: string
          message: string
          resolved_at?: string | null
          severity?: string
          source?: string | null
          source_ref?: string | null
          title: string
        }
        Update: {
          created_at?: string
          equipment_id?: string | null
          farm_id?: string
          id?: string
          kind?: string
          message?: string
          resolved_at?: string | null
          severity?: string
          source?: string | null
          source_ref?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "farm_notifications_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipments"
            referencedColumns: ["id"]
          },
        ]
      }
      farm_productivity_config: {
        Row: {
          contracted_demand_kw: number
          cycles_per_day: number
          default_flow_m3h: number
          demand_cost_per_kw: number
          farm_id: string
          intermediate_hour_post_end: string
          intermediate_hour_pre_start: string
          manual_operation_time_minutes: number
          manual_restart_delay_minutes: number
          manual_travel_minutes_per_trigger: number
          manual_useful_hours_per_day: number
          peak_hour_end: string
          peak_hour_start: string
          remote_operation_time_minutes: number
          reserved_hour_end: string
          reserved_hour_start: string
          session_gap_minutes: number
          tariff_intermediate: number | null
          tariff_off_peak: number
          tariff_peak: number
          tariff_reserved: number
          travel_distance_km: number
          travel_minutes_avg: number
          updated_at: string
          updated_by: string | null
          utility_name: string | null
          vehicle_cost_per_km: number
          worker_cost_per_hour: number
        }
        Insert: {
          contracted_demand_kw?: number
          cycles_per_day?: number
          default_flow_m3h?: number
          demand_cost_per_kw?: number
          farm_id: string
          intermediate_hour_post_end?: string
          intermediate_hour_pre_start?: string
          manual_operation_time_minutes?: number
          manual_restart_delay_minutes?: number
          manual_travel_minutes_per_trigger?: number
          manual_useful_hours_per_day?: number
          peak_hour_end?: string
          peak_hour_start?: string
          remote_operation_time_minutes?: number
          reserved_hour_end?: string
          reserved_hour_start?: string
          session_gap_minutes?: number
          tariff_intermediate?: number | null
          tariff_off_peak?: number
          tariff_peak?: number
          tariff_reserved?: number
          travel_distance_km?: number
          travel_minutes_avg?: number
          updated_at?: string
          updated_by?: string | null
          utility_name?: string | null
          vehicle_cost_per_km?: number
          worker_cost_per_hour?: number
        }
        Update: {
          contracted_demand_kw?: number
          cycles_per_day?: number
          default_flow_m3h?: number
          demand_cost_per_kw?: number
          farm_id?: string
          intermediate_hour_post_end?: string
          intermediate_hour_pre_start?: string
          manual_operation_time_minutes?: number
          manual_restart_delay_minutes?: number
          manual_travel_minutes_per_trigger?: number
          manual_useful_hours_per_day?: number
          peak_hour_end?: string
          peak_hour_start?: string
          remote_operation_time_minutes?: number
          reserved_hour_end?: string
          reserved_hour_start?: string
          session_gap_minutes?: number
          tariff_intermediate?: number | null
          tariff_off_peak?: number
          tariff_peak?: number
          tariff_reserved?: number
          travel_distance_km?: number
          travel_minutes_avg?: number
          updated_at?: string
          updated_by?: string | null
          utility_name?: string | null
          vehicle_cost_per_km?: number
          worker_cost_per_hour?: number
        }
        Relationships: []
      }
      farm_timing_config: {
        Row: {
          agent_backoff_after_timeouts: number
          agent_backoff_seconds: number
          auto_reset_minutes: number
          comm_levels_seconds: number
          comm_system_seconds: number
          default_command_timeout_ms: number
          default_polling_seconds: number
          farm_id: string
          offline_auto_seconds: number
          offline_levels_seconds: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          agent_backoff_after_timeouts?: number
          agent_backoff_seconds?: number
          auto_reset_minutes?: number
          comm_levels_seconds?: number
          comm_system_seconds?: number
          default_command_timeout_ms?: number
          default_polling_seconds?: number
          farm_id: string
          offline_auto_seconds?: number
          offline_levels_seconds?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          agent_backoff_after_timeouts?: number
          agent_backoff_seconds?: number
          auto_reset_minutes?: number
          comm_levels_seconds?: number
          comm_system_seconds?: number
          default_command_timeout_ms?: number
          default_polling_seconds?: number
          farm_id?: string
          offline_auto_seconds?: number
          offline_levels_seconds?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      farms: {
        Row: {
          agent_previous_version: string | null
          bell_alerts_enabled: boolean
          city: string | null
          created_at: string
          device_limit: number
          id: string
          ip_restriction_enabled: boolean
          is_demo: boolean
          latitude: number | null
          license_key: string | null
          license_status: string
          longitude: number | null
          max_devices: number | null
          modules: Json
          name: string
          plan: string
          state: string | null
          subscription_status: string
          target_agent_version: string | null
          timezone: string
          trial_end_date: string | null
          trial_start_date: string | null
          updated_at: string
        }
        Insert: {
          agent_previous_version?: string | null
          bell_alerts_enabled?: boolean
          city?: string | null
          created_at?: string
          device_limit?: number
          id?: string
          ip_restriction_enabled?: boolean
          is_demo?: boolean
          latitude?: number | null
          license_key?: string | null
          license_status?: string
          longitude?: number | null
          max_devices?: number | null
          modules?: Json
          name: string
          plan?: string
          state?: string | null
          subscription_status?: string
          target_agent_version?: string | null
          timezone?: string
          trial_end_date?: string | null
          trial_start_date?: string | null
          updated_at?: string
        }
        Update: {
          agent_previous_version?: string | null
          bell_alerts_enabled?: boolean
          city?: string | null
          created_at?: string
          device_limit?: number
          id?: string
          ip_restriction_enabled?: boolean
          is_demo?: boolean
          latitude?: number | null
          license_key?: string | null
          license_status?: string
          longitude?: number | null
          max_devices?: number | null
          modules?: Json
          name?: string
          plan?: string
          state?: string | null
          subscription_status?: string
          target_agent_version?: string | null
          timezone?: string
          trial_end_date?: string | null
          trial_start_date?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      flow_history: {
        Row: {
          accum_m3: number
          created_at: string
          daily_consumption_m3: number
          equipment_id: string
          farm_id: string
          flow_rate_m3h: number | null
          id: string
          ts: string
        }
        Insert: {
          accum_m3: number
          created_at?: string
          daily_consumption_m3?: number
          equipment_id: string
          farm_id: string
          flow_rate_m3h?: number | null
          id?: string
          ts?: string
        }
        Update: {
          accum_m3?: number
          created_at?: string
          daily_consumption_m3?: number
          equipment_id?: string
          farm_id?: string
          flow_rate_m3h?: number | null
          id?: string
          ts?: string
        }
        Relationships: [
          {
            foreignKeyName: "flow_history_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flow_history_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      ip_blocks: {
        Row: {
          blocked_until: string
          created_at: string
          ip: unknown
          level: number
          reason: string | null
          updated_at: string
        }
        Insert: {
          blocked_until: string
          created_at?: string
          ip: unknown
          level?: number
          reason?: string | null
          updated_at?: string
        }
        Update: {
          blocked_until?: string
          created_at?: string
          ip?: unknown
          level?: number
          reason?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      level_history: {
        Row: {
          equipment_id: string
          farm_id: string
          id: string
          is_calibrated: boolean
          meters: number | null
          percent: number | null
          raw: number | null
          read_at: string
        }
        Insert: {
          equipment_id: string
          farm_id: string
          id?: string
          is_calibrated?: boolean
          meters?: number | null
          percent?: number | null
          raw?: number | null
          read_at?: string
        }
        Update: {
          equipment_id?: string
          farm_id?: string
          id?: string
          is_calibrated?: boolean
          meters?: number | null
          percent?: number | null
          raw?: number | null
          read_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "level_history_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipments"
            referencedColumns: ["id"]
          },
        ]
      }
      login_attempts: {
        Row: {
          captcha_score: number | null
          created_at: string
          email: string | null
          id: string
          ip: unknown
          reason: string | null
          success: boolean
          user_agent: string | null
        }
        Insert: {
          captcha_score?: number | null
          created_at?: string
          email?: string | null
          id?: string
          ip: unknown
          reason?: string | null
          success: boolean
          user_agent?: string | null
        }
        Update: {
          captcha_score?: number | null
          created_at?: string
          email?: string | null
          id?: string
          ip?: unknown
          reason?: string | null
          success?: boolean
          user_agent?: string | null
        }
        Relationships: []
      }
      maintenance_visits: {
        Row: {
          created_at: string
          created_by_phone: string | null
          equipment_ids: string[]
          farm_id: string
          id: string
          notified_at: string | null
          notified_operators: string[]
          scheduled_date: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by_phone?: string | null
          equipment_ids?: string[]
          farm_id: string
          id?: string
          notified_at?: string | null
          notified_operators?: string[]
          scheduled_date: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by_phone?: string | null
          equipment_ids?: string[]
          farm_id?: string
          id?: string
          notified_at?: string | null
          notified_operators?: string[]
          scheduled_date?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_visits_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      master_manager_farms: {
        Row: {
          created_at: string
          farm_id: string
          id: string
          manager_id: string
        }
        Insert: {
          created_at?: string
          farm_id: string
          id?: string
          manager_id: string
        }
        Update: {
          created_at?: string
          farm_id?: string
          id?: string
          manager_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "master_manager_farms_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "master_manager_farms_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "master_managers"
            referencedColumns: ["id"]
          },
        ]
      }
      master_manager_permissions: {
        Row: {
          can_command_pumps: boolean
          can_edit_schedules: boolean
          can_manage_maintenance: boolean
          can_manage_operational_users: boolean
          can_view_dashboard: boolean
          can_view_financial: boolean
          can_view_indicators: boolean
          can_view_reports: boolean
          created_at: string
          manager_id: string
          updated_at: string
        }
        Insert: {
          can_command_pumps?: boolean
          can_edit_schedules?: boolean
          can_manage_maintenance?: boolean
          can_manage_operational_users?: boolean
          can_view_dashboard?: boolean
          can_view_financial?: boolean
          can_view_indicators?: boolean
          can_view_reports?: boolean
          created_at?: string
          manager_id: string
          updated_at?: string
        }
        Update: {
          can_command_pumps?: boolean
          can_edit_schedules?: boolean
          can_manage_maintenance?: boolean
          can_manage_operational_users?: boolean
          can_view_dashboard?: boolean
          can_view_financial?: boolean
          can_view_indicators?: boolean
          can_view_reports?: boolean
          created_at?: string
          manager_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "master_manager_permissions_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: true
            referencedRelation: "master_managers"
            referencedColumns: ["id"]
          },
        ]
      }
      master_managers: {
        Row: {
          cpf: string
          created_at: string
          created_by: string | null
          email: string
          full_name: string
          id: string
          must_change_password: boolean
          status: string
          updated_at: string
          user_id: string
          whatsapp: string
        }
        Insert: {
          cpf: string
          created_at?: string
          created_by?: string | null
          email: string
          full_name: string
          id?: string
          must_change_password?: boolean
          status?: string
          updated_at?: string
          user_id: string
          whatsapp: string
        }
        Update: {
          cpf?: string
          created_at?: string
          created_by?: string | null
          email?: string
          full_name?: string
          id?: string
          must_change_password?: boolean
          status?: string
          updated_at?: string
          user_id?: string
          whatsapp?: string
        }
        Relationships: []
      }
      national_holidays: {
        Row: {
          holiday_date: string
          name: string
        }
        Insert: {
          holiday_date: string
          name: string
        }
        Update: {
          holiday_date?: string
          name?: string
        }
        Relationships: []
      }
      peak_hour_config: {
        Row: {
          affected_equipment_ids: string[]
          auto_restart: boolean
          created_at: string
          enabled: boolean
          end_time: string
          excluded_equipment_ids: string[]
          farm_id: string
          id: string
          last_peak_off_at: string | null
          last_peak_on_at: string | null
          start_time: string
          updated_at: string
        }
        Insert: {
          affected_equipment_ids?: string[]
          auto_restart?: boolean
          created_at?: string
          enabled?: boolean
          end_time?: string
          excluded_equipment_ids?: string[]
          farm_id: string
          id?: string
          last_peak_off_at?: string | null
          last_peak_on_at?: string | null
          start_time?: string
          updated_at?: string
        }
        Update: {
          affected_equipment_ids?: string[]
          auto_restart?: boolean
          created_at?: string
          enabled?: boolean
          end_time?: string
          excluded_equipment_ids?: string[]
          farm_id?: string
          id?: string
          last_peak_off_at?: string | null
          last_peak_on_at?: string | null
          start_time?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "peak_hour_config_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: true
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      pending_notifications: {
        Row: {
          change_type: string
          changed_by: string | null
          changed_via: string | null
          created_at: string
          equipment_id: string | null
          farm_id: string | null
          id: string
          last_error: string | null
          new_value: string | null
          old_value: string | null
          payload: Json
          processed: boolean
          processed_at: string | null
          retry_at: string | null
          retry_count: number
        }
        Insert: {
          change_type: string
          changed_by?: string | null
          changed_via?: string | null
          created_at?: string
          equipment_id?: string | null
          farm_id?: string | null
          id?: string
          last_error?: string | null
          new_value?: string | null
          old_value?: string | null
          payload?: Json
          processed?: boolean
          processed_at?: string | null
          retry_at?: string | null
          retry_count?: number
        }
        Update: {
          change_type?: string
          changed_by?: string | null
          changed_via?: string | null
          created_at?: string
          equipment_id?: string | null
          farm_id?: string | null
          id?: string
          last_error?: string | null
          new_value?: string | null
          old_value?: string | null
          payload?: Json
          processed?: boolean
          processed_at?: string | null
          retry_at?: string | null
          retry_count?: number
        }
        Relationships: []
      }
      platform_admins: {
        Row: {
          created_at: string
          created_by: string | null
          notes: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          notes?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          notes?: string | null
          user_id?: string
        }
        Relationships: []
      }
      platform_alert_reads: {
        Row: {
          alert_id: string
          alert_source: string
          id: string
          read_at: string
          user_id: string
        }
        Insert: {
          alert_id: string
          alert_source: string
          id?: string
          read_at?: string
          user_id: string
        }
        Update: {
          alert_id?: string
          alert_source?: string
          id?: string
          read_at?: string
          user_id?: string
        }
        Relationships: []
      }
      platform_settings: {
        Row: {
          key: string
          updated_at: string
          updated_by: string | null
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Update: {
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Relationships: []
      }
      platform_support: {
        Row: {
          created_at: string
          created_by: string | null
          notes: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          notes?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          notes?: string | null
          user_id?: string
        }
        Relationships: []
      }
      plc_groups: {
        Row: {
          created_at: string
          farm_id: string
          hw_id: string
          id: string
          name: string
          output_count: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          farm_id: string
          hw_id: string
          id?: string
          name: string
          output_count?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          farm_id?: string
          hw_id?: string
          id?: string
          name?: string
          output_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "plc_groups_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          default_farm_id: string | null
          email: string | null
          full_name: string | null
          id: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          default_farm_id?: string | null
          email?: string | null
          full_name?: string | null
          id: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          default_farm_id?: string | null
          email?: string | null
          full_name?: string | null
          id?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_default_farm_id_fkey"
            columns: ["default_farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      provisioning_tokens: {
        Row: {
          consumed_at: string | null
          consumed_by_machine_hash: string | null
          consumed_ip: string | null
          created_at: string
          created_by: string | null
          expires_at: string
          farm_id: string
          id: string
          notes: string | null
          revoked_at: string | null
          revoked_reason: string | null
          token: string
        }
        Insert: {
          consumed_at?: string | null
          consumed_by_machine_hash?: string | null
          consumed_ip?: string | null
          created_at?: string
          created_by?: string | null
          expires_at?: string
          farm_id: string
          id?: string
          notes?: string | null
          revoked_at?: string | null
          revoked_reason?: string | null
          token: string
        }
        Update: {
          consumed_at?: string | null
          consumed_by_machine_hash?: string | null
          consumed_ip?: string | null
          created_at?: string
          created_by?: string | null
          expires_at?: string
          farm_id?: string
          id?: string
          notes?: string | null
          revoked_at?: string | null
          revoked_reason?: string | null
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "provisioning_tokens_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      pump_runtime: {
        Row: {
          created_at: string
          duration_seconds: number | null
          ended_at: string | null
          equipment_id: string
          farm_id: string
          id: string
          started_at: string
        }
        Insert: {
          created_at?: string
          duration_seconds?: number | null
          ended_at?: string | null
          equipment_id: string
          farm_id: string
          id?: string
          started_at?: string
        }
        Update: {
          created_at?: string
          duration_seconds?: number | null
          ended_at?: string | null
          equipment_id?: string
          farm_id?: string
          id?: string
          started_at?: string
        }
        Relationships: []
      }
      registration_codes: {
        Row: {
          code: string
          created_at: string
          created_by_phone: string
          expires_at: string
          farm_id: string
          generated_by: string | null
          id: string
          status: string
          target_phone: string | null
          used_at: string | null
          used_by_phone: string | null
        }
        Insert: {
          code: string
          created_at?: string
          created_by_phone: string
          expires_at: string
          farm_id: string
          generated_by?: string | null
          id?: string
          status?: string
          target_phone?: string | null
          used_at?: string | null
          used_by_phone?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          created_by_phone?: string
          expires_at?: string
          farm_id?: string
          generated_by?: string | null
          id?: string
          status?: string
          target_phone?: string | null
          used_at?: string | null
          used_by_phone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "registration_codes_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      registration_flow_state: {
        Row: {
          code: string | null
          data: Json
          farm_id: string | null
          phone: string
          started_at: string
          step: string
          updated_at: string
        }
        Insert: {
          code?: string | null
          data?: Json
          farm_id?: string | null
          phone: string
          started_at?: string
          step: string
          updated_at?: string
        }
        Update: {
          code?: string | null
          data?: Json
          farm_id?: string | null
          phone?: string
          started_at?: string
          step?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "registration_flow_state_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      registration_verifications: {
        Row: {
          city_from_ip: string | null
          created_at: string
          id: string
          ip_address: string | null
          latitude: number | null
          location_accuracy: number | null
          location_denied: boolean
          longitude: number | null
          registration_code: string | null
          state_from_ip: string | null
          target_phone: string
          token: string
          user_agent: string | null
          verified_at: string | null
        }
        Insert: {
          city_from_ip?: string | null
          created_at?: string
          id?: string
          ip_address?: string | null
          latitude?: number | null
          location_accuracy?: number | null
          location_denied?: boolean
          longitude?: number | null
          registration_code?: string | null
          state_from_ip?: string | null
          target_phone: string
          token: string
          user_agent?: string | null
          verified_at?: string | null
        }
        Update: {
          city_from_ip?: string | null
          created_at?: string
          id?: string
          ip_address?: string | null
          latitude?: number | null
          location_accuracy?: number | null
          location_denied?: boolean
          longitude?: number | null
          registration_code?: string | null
          state_from_ip?: string | null
          target_phone?: string
          token?: string
          user_agent?: string | null
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "registration_verifications_registration_code_fkey"
            columns: ["registration_code"]
            isOneToOne: false
            referencedRelation: "registration_codes"
            referencedColumns: ["code"]
          },
        ]
      }
      rf_routing: {
        Row: {
          farm_id: string
          radio: string
          updated_at: string
          via_repetidor: boolean
        }
        Insert: {
          farm_id: string
          radio?: string
          updated_at?: string
          via_repetidor?: boolean
        }
        Update: {
          farm_id?: string
          radio?: string
          updated_at?: string
          via_repetidor?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "rf_routing_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: true
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      sectors: {
        Row: {
          created_at: string
          farm_id: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          farm_id: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          farm_id?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sectors_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      security_alerts: {
        Row: {
          action_taken: string | null
          alert_type: string
          created_at: string
          details: Json
          email: string | null
          id: string
          ip: unknown
          user_id: string | null
          whatsapp_error: string | null
          whatsapp_sent: boolean
        }
        Insert: {
          action_taken?: string | null
          alert_type: string
          created_at?: string
          details?: Json
          email?: string | null
          id?: string
          ip?: unknown
          user_id?: string | null
          whatsapp_error?: string | null
          whatsapp_sent?: boolean
        }
        Update: {
          action_taken?: string | null
          alert_type?: string
          created_at?: string
          details?: Json
          email?: string | null
          id?: string
          ip?: unknown
          user_id?: string | null
          whatsapp_error?: string | null
          whatsapp_sent?: boolean
        }
        Relationships: []
      }
      service_mode_locks: {
        Row: {
          expires_at: string
          farm_id: string
          locked_at: string
          locked_by: string | null
          tsnn: string
        }
        Insert: {
          expires_at?: string
          farm_id: string
          locked_at?: string
          locked_by?: string | null
          tsnn: string
        }
        Update: {
          expires_at?: string
          farm_id?: string
          locked_at?: string
          locked_by?: string | null
          tsnn?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_mode_locks_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      site_health: {
        Row: {
          agent_status: string
          agent_version: string | null
          com_connected: boolean
          com_port: string | null
          created_at: string
          farm_id: string
          firmware_server: string | null
          id: string
          last_error: string | null
          last_heartbeat: string
          pending_commands: number | null
          updated_at: string
          uptime_seconds: number | null
        }
        Insert: {
          agent_status?: string
          agent_version?: string | null
          com_connected?: boolean
          com_port?: string | null
          created_at?: string
          farm_id: string
          firmware_server?: string | null
          id?: string
          last_error?: string | null
          last_heartbeat?: string
          pending_commands?: number | null
          updated_at?: string
          uptime_seconds?: number | null
        }
        Update: {
          agent_status?: string
          agent_version?: string | null
          com_connected?: boolean
          com_port?: string | null
          created_at?: string
          farm_id?: string
          firmware_server?: string | null
          id?: string
          last_error?: string | null
          last_heartbeat?: string
          pending_commands?: number | null
          updated_at?: string
          uptime_seconds?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "site_health_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: true
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      tampering_events: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          action_taken: string | null
          actual_hash: string | null
          agent_version: string | null
          details: Json
          device_license_id: string | null
          expected_hash: string | null
          farm_id: string
          id: string
          kind: Database["public"]["Enums"]["tampering_kind"]
          level: Database["public"]["Enums"]["tampering_level"]
          reported_at: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          action_taken?: string | null
          actual_hash?: string | null
          agent_version?: string | null
          details?: Json
          device_license_id?: string | null
          expected_hash?: string | null
          farm_id: string
          id?: string
          kind: Database["public"]["Enums"]["tampering_kind"]
          level?: Database["public"]["Enums"]["tampering_level"]
          reported_at?: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          action_taken?: string | null
          actual_hash?: string | null
          agent_version?: string | null
          details?: Json
          device_license_id?: string | null
          expected_hash?: string | null
          farm_id?: string
          id?: string
          kind?: Database["public"]["Enums"]["tampering_kind"]
          level?: Database["public"]["Enums"]["tampering_level"]
          reported_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tampering_events_device_license_id_fkey"
            columns: ["device_license_id"]
            isOneToOne: false
            referencedRelation: "device_licenses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tampering_events_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          farm_id: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          farm_id: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          farm_id?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      watchdog_alerts_state: {
        Row: {
          alert_type: string
          created_at: string
          farm_id: string
          id: string
          is_active: boolean
          last_message: string | null
          last_sent_at: string
          metadata: Json | null
          updated_at: string
        }
        Insert: {
          alert_type: string
          created_at?: string
          farm_id: string
          id?: string
          is_active?: boolean
          last_message?: string | null
          last_sent_at?: string
          metadata?: Json | null
          updated_at?: string
        }
        Update: {
          alert_type?: string
          created_at?: string
          farm_id?: string
          id?: string
          is_active?: boolean
          last_message?: string | null
          last_sent_at?: string
          metadata?: Json | null
          updated_at?: string
        }
        Relationships: []
      }
      water_balance_state: {
        Row: {
          farm_id: string
          last_alert_critico_at: string | null
          last_alert_insuficiente_at: string | null
          last_alert_ponta_at: string | null
          last_alert_sem_captacao_at: string | null
          prediction_hours: number | null
          status: string
          status_since: string
          updated_at: string
        }
        Insert: {
          farm_id: string
          last_alert_critico_at?: string | null
          last_alert_insuficiente_at?: string | null
          last_alert_ponta_at?: string | null
          last_alert_sem_captacao_at?: string | null
          prediction_hours?: number | null
          status: string
          status_since?: string
          updated_at?: string
        }
        Update: {
          farm_id?: string
          last_alert_critico_at?: string | null
          last_alert_insuficiente_at?: string | null
          last_alert_ponta_at?: string | null
          last_alert_sem_captacao_at?: string | null
          prediction_hours?: number | null
          status?: string
          status_since?: string
          updated_at?: string
        }
        Relationships: []
      }
      whatsapp_alert_send_claims: {
        Row: {
          alert_type: string
          claimed_at: string
          equipment_id: string
          phone: string
        }
        Insert: {
          alert_type: string
          claimed_at?: string
          equipment_id: string
          phone: string
        }
        Update: {
          alert_type?: string
          claimed_at?: string
          equipment_id?: string
          phone?: string
        }
        Relationships: []
      }
      whatsapp_alert_settings: {
        Row: {
          alert_local_change_enabled: boolean
          alert_offline_enabled: boolean
          alert_peak_hours_enabled: boolean
          alerts_enabled: boolean
          created_at: string
          farm_id: string | null
          id: string
          peak_hour_end: string
          peak_hour_start: string
          peak_hour_weekdays: number[]
          technical_team_phone: string | null
          updated_at: string
        }
        Insert: {
          alert_local_change_enabled?: boolean
          alert_offline_enabled?: boolean
          alert_peak_hours_enabled?: boolean
          alerts_enabled?: boolean
          created_at?: string
          farm_id?: string | null
          id?: string
          peak_hour_end?: string
          peak_hour_start?: string
          peak_hour_weekdays?: number[]
          technical_team_phone?: string | null
          updated_at?: string
        }
        Update: {
          alert_local_change_enabled?: boolean
          alert_offline_enabled?: boolean
          alert_peak_hours_enabled?: boolean
          alerts_enabled?: boolean
          created_at?: string
          farm_id?: string | null
          id?: string
          peak_hour_end?: string
          peak_hour_start?: string
          peak_hour_weekdays?: number[]
          technical_team_phone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_alert_settings_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: true
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_alerts_log: {
        Row: {
          alert_type: string
          created_at: string
          equipment_id: string
          equipment_name: string | null
          id: string
          message_sent: string | null
          new_state: string | null
          previous_state: string | null
        }
        Insert: {
          alert_type: string
          created_at?: string
          equipment_id: string
          equipment_name?: string | null
          id?: string
          message_sent?: string | null
          new_state?: string | null
          previous_state?: string | null
        }
        Update: {
          alert_type?: string
          created_at?: string
          equipment_id?: string
          equipment_name?: string | null
          id?: string
          message_sent?: string | null
          new_state?: string | null
          previous_state?: string | null
        }
        Relationships: []
      }
      whatsapp_audit_log: {
        Row: {
          actor_name: string | null
          actor_phone: string | null
          created_at: string
          details: Json | null
          event_type: string
          farm_id: string | null
          id: string
          target_name: string | null
          target_phone: string | null
        }
        Insert: {
          actor_name?: string | null
          actor_phone?: string | null
          created_at?: string
          details?: Json | null
          event_type: string
          farm_id?: string | null
          id?: string
          target_name?: string | null
          target_phone?: string | null
        }
        Update: {
          actor_name?: string | null
          actor_phone?: string | null
          created_at?: string
          details?: Json | null
          event_type?: string
          farm_id?: string | null
          id?: string
          target_name?: string | null
          target_phone?: string | null
        }
        Relationships: []
      }
      whatsapp_blocked_groups: {
        Row: {
          blocked_by: string | null
          created_at: string
          group_id: string
          id: string
          reason: string | null
        }
        Insert: {
          blocked_by?: string | null
          created_at?: string
          group_id: string
          id?: string
          reason?: string | null
        }
        Update: {
          blocked_by?: string | null
          created_at?: string
          group_id?: string
          id?: string
          reason?: string | null
        }
        Relationships: []
      }
      whatsapp_broadcasts: {
        Row: {
          created_at: string
          farm_id: string | null
          id: string
          message: string
          scheduled_at: string | null
          sent_at: string | null
          sent_by: string | null
          sent_count: number
          status: string
          target: string
        }
        Insert: {
          created_at?: string
          farm_id?: string | null
          id?: string
          message: string
          scheduled_at?: string | null
          sent_at?: string | null
          sent_by?: string | null
          sent_count?: number
          status?: string
          target?: string
        }
        Update: {
          created_at?: string
          farm_id?: string | null
          id?: string
          message?: string
          scheduled_at?: string | null
          sent_at?: string | null
          sent_by?: string | null
          sent_count?: number
          status?: string
          target?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_broadcasts_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_config: {
        Row: {
          ai_enabled: boolean
          ai_instructions: string | null
          alert_on_bridge_down: boolean
          alert_on_failure: boolean
          alert_on_local_action: boolean
          alert_on_offline: boolean
          api_token: string | null
          audio_transcription: boolean
          bot_number: string | null
          created_at: string
          daily_summary: boolean
          farm_id: string
          id: string
          is_connected: boolean
          offline_threshold_minutes: number
          phone_number_id: string | null
          tech_group_id: string | null
          updated_at: string
          webhook_verify_token: string
        }
        Insert: {
          ai_enabled?: boolean
          ai_instructions?: string | null
          alert_on_bridge_down?: boolean
          alert_on_failure?: boolean
          alert_on_local_action?: boolean
          alert_on_offline?: boolean
          api_token?: string | null
          audio_transcription?: boolean
          bot_number?: string | null
          created_at?: string
          daily_summary?: boolean
          farm_id: string
          id?: string
          is_connected?: boolean
          offline_threshold_minutes?: number
          phone_number_id?: string | null
          tech_group_id?: string | null
          updated_at?: string
          webhook_verify_token?: string
        }
        Update: {
          ai_enabled?: boolean
          ai_instructions?: string | null
          alert_on_bridge_down?: boolean
          alert_on_failure?: boolean
          alert_on_local_action?: boolean
          alert_on_offline?: boolean
          api_token?: string | null
          audio_transcription?: boolean
          bot_number?: string | null
          created_at?: string
          daily_summary?: boolean
          farm_id?: string
          id?: string
          is_connected?: boolean
          offline_threshold_minutes?: number
          phone_number_id?: string | null
          tech_group_id?: string | null
          updated_at?: string
          webhook_verify_token?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_config_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: true
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_conversation_state: {
        Row: {
          awaiting: string
          context: Json
          created_at: string
          operator_phone: string
          updated_at: string
        }
        Insert: {
          awaiting: string
          context?: Json
          created_at?: string
          operator_phone: string
          updated_at?: string
        }
        Update: {
          awaiting?: string
          context?: Json
          created_at?: string
          operator_phone?: string
          updated_at?: string
        }
        Relationships: []
      }
      whatsapp_failed_attempts: {
        Row: {
          attempt_type: string
          attempted_value: string | null
          created_at: string
          id: string
          phone: string
        }
        Insert: {
          attempt_type?: string
          attempted_value?: string | null
          created_at?: string
          id?: string
          phone: string
        }
        Update: {
          attempt_type?: string
          attempted_value?: string | null
          created_at?: string
          id?: string
          phone?: string
        }
        Relationships: []
      }
      whatsapp_groups: {
        Row: {
          alert_channel: string
          alerts_enabled: boolean
          commands_enabled: boolean
          created_at: string
          farm_id: string | null
          group_id: string
          group_name: string | null
          id: string
          is_active: boolean
          muted_until: string | null
          registered_by: string | null
          updated_at: string
        }
        Insert: {
          alert_channel?: string
          alerts_enabled?: boolean
          commands_enabled?: boolean
          created_at?: string
          farm_id?: string | null
          group_id: string
          group_name?: string | null
          id?: string
          is_active?: boolean
          muted_until?: string | null
          registered_by?: string | null
          updated_at?: string
        }
        Update: {
          alert_channel?: string
          alerts_enabled?: boolean
          commands_enabled?: boolean
          created_at?: string
          farm_id?: string | null
          group_id?: string
          group_name?: string | null
          id?: string
          is_active?: boolean
          muted_until?: string | null
          registered_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_groups_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_invite_codes: {
        Row: {
          code: string
          created_at: string
          created_by: string | null
          current_uses: number
          expires_at: string | null
          farm_id: string
          id: string
          is_active: boolean
          max_uses: number
        }
        Insert: {
          code: string
          created_at?: string
          created_by?: string | null
          current_uses?: number
          expires_at?: string | null
          farm_id: string
          id?: string
          is_active?: boolean
          max_uses?: number
        }
        Update: {
          code?: string
          created_at?: string
          created_by?: string | null
          current_uses?: number
          expires_at?: string | null
          farm_id?: string
          id?: string
          is_active?: boolean
          max_uses?: number
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_invite_codes_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_maintenance_pending: {
        Row: {
          awaiting_numbers: boolean
          base_label: string | null
          created_at: string
          equipment_id: string | null
          equipment_ids: string[]
          equipment_name: string | null
          equipment_names: string[]
          expires_at: string
          farm_id: string | null
          id: string
          operator_id: string | null
          operator_phone: string
        }
        Insert: {
          awaiting_numbers?: boolean
          base_label?: string | null
          created_at?: string
          equipment_id?: string | null
          equipment_ids?: string[]
          equipment_name?: string | null
          equipment_names?: string[]
          expires_at?: string
          farm_id?: string | null
          id?: string
          operator_id?: string | null
          operator_phone: string
        }
        Update: {
          awaiting_numbers?: boolean
          base_label?: string | null
          created_at?: string
          equipment_id?: string | null
          equipment_ids?: string[]
          equipment_name?: string | null
          equipment_names?: string[]
          expires_at?: string
          farm_id?: string | null
          id?: string
          operator_id?: string | null
          operator_phone?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_maintenance_pending_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_maintenance_pending_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_manager_registration_state: {
        Row: {
          created_at: string
          data: Json
          farm_id: string | null
          step: number
          super_admin_phone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          data?: Json
          farm_id?: string | null
          step?: number
          super_admin_phone: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          data?: Json
          farm_id?: string | null
          step?: number
          super_admin_phone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_manager_registration_state_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_message_log: {
        Row: {
          audio_duration_seconds: number | null
          command_parsed: string | null
          command_result: string | null
          created_at: string
          direction: string
          farm_id: string | null
          group_id: string | null
          id: string
          message_body: string | null
          message_id: string | null
          message_type: string | null
          metadata: Json | null
          operator_id: string | null
          operator_name: string | null
          original_type: string | null
          phone: string
          timestamp_meta: string | null
        }
        Insert: {
          audio_duration_seconds?: number | null
          command_parsed?: string | null
          command_result?: string | null
          created_at?: string
          direction: string
          farm_id?: string | null
          group_id?: string | null
          id?: string
          message_body?: string | null
          message_id?: string | null
          message_type?: string | null
          metadata?: Json | null
          operator_id?: string | null
          operator_name?: string | null
          original_type?: string | null
          phone: string
          timestamp_meta?: string | null
        }
        Update: {
          audio_duration_seconds?: number | null
          command_parsed?: string | null
          command_result?: string | null
          created_at?: string
          direction?: string
          farm_id?: string | null
          group_id?: string | null
          id?: string
          message_body?: string | null
          message_id?: string | null
          message_type?: string | null
          metadata?: Json | null
          operator_id?: string | null
          operator_name?: string | null
          original_type?: string | null
          phone?: string
          timestamp_meta?: string | null
        }
        Relationships: []
      }
      whatsapp_notification_batches: {
        Row: {
          action: string
          closed_at: string | null
          created_at: string
          exclude_phone: string | null
          farm_id: string
          id: string
          items: Json
          last_added_at: string
          opened_at: string
          operator_key: string
          operator_name: string
          sent_at: string | null
          status: string
          updated_at: string
          via: string
        }
        Insert: {
          action: string
          closed_at?: string | null
          created_at?: string
          exclude_phone?: string | null
          farm_id: string
          id?: string
          items?: Json
          last_added_at?: string
          opened_at?: string
          operator_key: string
          operator_name: string
          sent_at?: string | null
          status?: string
          updated_at?: string
          via: string
        }
        Update: {
          action?: string
          closed_at?: string | null
          created_at?: string
          exclude_phone?: string | null
          farm_id?: string
          id?: string
          items?: Json
          last_added_at?: string
          opened_at?: string
          operator_key?: string
          operator_name?: string
          sent_at?: string | null
          status?: string
          updated_at?: string
          via?: string
        }
        Relationships: []
      }
      whatsapp_operators: {
        Row: {
          ai_enabled: boolean
          approval_status: string
          approved_at: string | null
          approved_by_phone: string | null
          audio_enabled: boolean
          can_approve: boolean
          can_check_status: boolean
          can_control: boolean
          can_register: boolean
          can_schedule: boolean
          can_turn_off: boolean
          can_turn_on: boolean
          cpf: string | null
          created_at: string
          deactivated_at: string | null
          deactivated_by: string | null
          deactivation_reason: string | null
          default_farm_id: string | null
          farm_id: string | null
          first_interaction_at: string | null
          full_name: string | null
          id: string
          is_active: boolean
          is_approver: boolean
          last_message_at: string | null
          location: string | null
          name: string
          notification_preference: string
          phone: string
          receive_alerts: boolean
          registered_at: string | null
          registered_via_code: string | null
          registration_lat: number | null
          registration_lng: number | null
          registration_location_text: string | null
          role: string
          skip_confirmation: boolean
          updated_at: string
          user_id: string | null
        }
        Insert: {
          ai_enabled?: boolean
          approval_status?: string
          approved_at?: string | null
          approved_by_phone?: string | null
          audio_enabled?: boolean
          can_approve?: boolean
          can_check_status?: boolean
          can_control?: boolean
          can_register?: boolean
          can_schedule?: boolean
          can_turn_off?: boolean
          can_turn_on?: boolean
          cpf?: string | null
          created_at?: string
          deactivated_at?: string | null
          deactivated_by?: string | null
          deactivation_reason?: string | null
          default_farm_id?: string | null
          farm_id?: string | null
          first_interaction_at?: string | null
          full_name?: string | null
          id?: string
          is_active?: boolean
          is_approver?: boolean
          last_message_at?: string | null
          location?: string | null
          name: string
          notification_preference?: string
          phone: string
          receive_alerts?: boolean
          registered_at?: string | null
          registered_via_code?: string | null
          registration_lat?: number | null
          registration_lng?: number | null
          registration_location_text?: string | null
          role?: string
          skip_confirmation?: boolean
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          ai_enabled?: boolean
          approval_status?: string
          approved_at?: string | null
          approved_by_phone?: string | null
          audio_enabled?: boolean
          can_approve?: boolean
          can_check_status?: boolean
          can_control?: boolean
          can_register?: boolean
          can_schedule?: boolean
          can_turn_off?: boolean
          can_turn_on?: boolean
          cpf?: string | null
          created_at?: string
          deactivated_at?: string | null
          deactivated_by?: string | null
          deactivation_reason?: string | null
          default_farm_id?: string | null
          farm_id?: string | null
          first_interaction_at?: string | null
          full_name?: string | null
          id?: string
          is_active?: boolean
          is_approver?: boolean
          last_message_at?: string | null
          location?: string | null
          name?: string
          notification_preference?: string
          phone?: string
          receive_alerts?: boolean
          registered_at?: string | null
          registered_via_code?: string | null
          registration_lat?: number | null
          registration_lng?: number | null
          registration_location_text?: string | null
          role?: string
          skip_confirmation?: boolean
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_operators_default_farm_id_fkey"
            columns: ["default_farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_operators_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_pending_actions: {
        Row: {
          action_type: string
          created_at: string
          equipment_id: string
          equipment_name: string
          farm_id: string | null
          id: string
          operator_id: string | null
          operator_phone: string
          original_text: string | null
        }
        Insert: {
          action_type: string
          created_at?: string
          equipment_id: string
          equipment_name: string
          farm_id?: string | null
          id?: string
          operator_id?: string | null
          operator_phone: string
          original_text?: string | null
        }
        Update: {
          action_type?: string
          created_at?: string
          equipment_id?: string
          equipment_name?: string
          farm_id?: string | null
          id?: string
          operator_id?: string | null
          operator_phone?: string
          original_text?: string | null
        }
        Relationships: []
      }
      whatsapp_registration_requests: {
        Row: {
          consent_given: boolean
          created_at: string
          farm_id: string | null
          farm_name_provided: string | null
          id: string
          invite_code_used: string | null
          location_skipped: boolean
          name: string | null
          phone: string
          registration_lat: number | null
          registration_lng: number | null
          registration_location_text: string | null
          rejection_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          role_provided: string | null
          status: string
          step: number
        }
        Insert: {
          consent_given?: boolean
          created_at?: string
          farm_id?: string | null
          farm_name_provided?: string | null
          id?: string
          invite_code_used?: string | null
          location_skipped?: boolean
          name?: string | null
          phone: string
          registration_lat?: number | null
          registration_lng?: number | null
          registration_location_text?: string | null
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          role_provided?: string | null
          status?: string
          step?: number
        }
        Update: {
          consent_given?: boolean
          created_at?: string
          farm_id?: string | null
          farm_name_provided?: string | null
          id?: string
          invite_code_used?: string | null
          location_skipped?: boolean
          name?: string | null
          phone?: string
          registration_lat?: number | null
          registration_lng?: number | null
          registration_location_text?: string | null
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          role_provided?: string | null
          status?: string
          step?: number
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_registration_requests_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_trial_notifications_log: {
        Row: {
          farm_id: string
          id: string
          milestone: string
          sent_at: string
        }
        Insert: {
          farm_id: string
          id?: string
          milestone: string
          sent_at?: string
        }
        Update: {
          farm_id?: string
          id?: string
          milestone?: string
          sent_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_trial_notifications_log_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      _eq_output_on: {
        Args: { out_state: string; saida: number }
        Returns: boolean
      }
      acknowledge_tampering_event: {
        Args: { _action_taken: string; _event_id: string }
        Returns: boolean
      }
      apply_flow_telemetry: {
        Args: {
          _farm_id: string
          _plc_hw_id: string
          _raw_response?: string
          _raw_value: number
        }
        Returns: string
      }
      apply_level_telemetry: {
        Args: {
          _farm_id: string
          _plc_hw_id: string
          _raw_response?: string
          _raw_value: number
          _sensor_index: number
        }
        Returns: string
      }
      apply_pump_telemetry: {
        Args: {
          _command_id: string
          _farm_id: string
          _origin?: string
          _payload: string
          _raw_response: string
          _signal_bars: number
          _tsnn: string
        }
        Returns: string
      }
      calculate_energy_efficiency_for_date: {
        Args: { _date: string; _farm_id: string }
        Returns: {
          cycle_date: string
          efficiency_percent: number
          lost_minutes: number
          minutes_on_during_peak: number
          post_peak_ok_count: number
          post_peak_startup_time: string
          pre_peak_ok_count: number
          pre_peak_shutdown_time: string
          pumps_on_during_peak: number
          pumps_operated: number
        }[]
      }
      calculate_energy_efficiency_pumps_for_date: {
        Args: { _date: string; _farm_id: string }
        Returns: {
          early_off_min: number
          equipment_id: string
          equipment_name: string
          first_on: string
          last_off: string
          late_min: number
          mode: string
          peak_minutes: number
          peak_violation: boolean
          post_status: string
          pre_status: string
        }[]
      }
      calculate_pump_peak_minutes_for_window: {
        Args: { _farm_id: string; _window_end: string; _window_start: string }
        Returns: {
          equipment_id: string
          peak_minutes: number
        }[]
      }
      can_write_farm: {
        Args: { _farm_id: string; _user_id: string }
        Returns: boolean
      }
      cancel_pending_pollings_for_plc: {
        Args: { _farm_id: string; _reason?: string; _tsnn: string }
        Returns: number
      }
      check_bridge_heartbeats: { Args: never; Returns: undefined }
      check_farm_device_access: {
        Args: { _farm_id: string; _ip: string }
        Returns: boolean
      }
      check_farm_ip_allowed: {
        Args: { _farm_id: string; _ip: string }
        Returns: boolean
      }
      check_peak_efficiency_alerts: { Args: never; Returns: number }
      check_scraping_pattern: {
        Args: { _user_id: string }
        Returns: {
          distinct_endpoints: number
          hits_last_minute: number
          is_abusive: boolean
          reason: string
        }[]
      }
      check_unresponsive_commands: { Args: never; Returns: undefined }
      check_water_balance_alerts: { Args: never; Returns: Json }
      claim_active_session: {
        Args: {
          _device_fp: string
          _ip: string
          _session_id: string
          _user_agent: string
        }
        Returns: undefined
      }
      claim_whatsapp_alert_send: {
        Args: {
          p_alert_type: string
          p_equipment_id: string
          p_phone: string
          p_window_seconds?: number
        }
        Returns: boolean
      }
      cleanup_api_hits: { Args: never; Returns: undefined }
      cleanup_stale_data: { Args: never; Returns: Json }
      clear_agent_update: { Args: { _farm_id: string }; Returns: undefined }
      close_orphan_offline_cycles: { Args: never; Returns: number }
      close_orphan_pump_runtime: {
        Args: { _max_idle_minutes?: number }
        Returns: number
      }
      compact_old_level_history: { Args: never; Returns: undefined }
      compute_all_energy_efficiency: {
        Args: { _date?: string }
        Returns: number
      }
      compute_energy_efficiency: {
        Args: { _date: string; _farm_id: string }
        Returns: undefined
      }
      compute_estimated_consumption: {
        Args: { _date: string; _farm_id: string }
        Returns: number
      }
      create_farm_with_owner: {
        Args: {
          _city?: string
          _name: string
          _plan?: string
          _state?: string
          _timezone?: string
        }
        Returns: string
      }
      current_operator_phone: { Args: { _uid: string }; Returns: string }
      deactivate_stale_devices: { Args: never; Returns: undefined }
      debug_alert_system: { Args: never; Returns: Json }
      enqueue_polling_for_due_equipments: {
        Args: { _farm_id: string }
        Returns: number
      }
      enqueue_polling_for_due_equipments_internal:
        | {
            Args: never
            Returns: {
              enqueued: number
              farm_id: string
              farm_name: string
            }[]
          }
        | { Args: { _farm_id: string }; Returns: number }
      enqueue_polling_for_online_farms: { Args: never; Returns: number }
      enqueue_protective_off_for_offline_pumps: {
        Args: never
        Returns: {
          command_id: string
          equipment_id: string
          equipment_name: string
          farm_id: string
        }[]
      }
      enqueue_reset_pump_command: {
        Args: { _equipment_id: string; _farm_id: string; _reason?: string }
        Returns: string
      }
      enqueue_startup_sync_polling: {
        Args: { _farm_id: string }
        Returns: number
      }
      enqueue_turn_on_timeout_resets: {
        Args: { _farm_id?: string }
        Returns: number
      }
      ensure_farm_log_key: {
        Args: { _farm_id: string; _new_key: string }
        Returns: string
      }
      farm_backup_create: {
        Args: { _farm_id: string; _label?: string; _trigger_kind?: string }
        Returns: string
      }
      farm_backup_create_all_farms: { Args: never; Returns: number }
      farm_backup_list: {
        Args: { _farm_id: string }
        Returns: {
          created_at: string
          created_by: string
          farm_id: string
          id: string
          label: string
          meta: Json
          size_bytes: number
          trigger_kind: string
        }[]
      }
      farm_backup_purge_old: { Args: never; Returns: number }
      farm_backup_restore: {
        Args: {
          _backup_id: string
          _restore_automacao?: boolean
          _restore_cadastros?: boolean
          _restore_historico?: boolean
          _restore_usuarios?: boolean
        }
        Returns: Json
      }
      farm_messages_active: {
        Args: { _farm_id: string }
        Returns: {
          body: string
          created_at: string
          expires_at: string
          id: string
          level: string
          title: string
        }[]
      }
      farm_messages_dismiss: {
        Args: { _message_id: string }
        Returns: undefined
      }
      farm_set_modules: {
        Args: { _farm_id: string; _patch: Json }
        Returns: Json
      }
      get_agent_target_version: {
        Args: { _farm_id: string }
        Returns: {
          artifact_type: string
          download_url: string
          file_hash: string
          file_size_bytes: number
          is_pinned: boolean
          mandatory: boolean
          storage_path: string
          target_version: string
        }[]
      }
      get_command_result: {
        Args: { p_command_id: string }
        Returns: {
          error_message: string
          response: string
          status: string
        }[]
      }
      get_energy_efficiency_history: {
        Args: { _days?: number; _farm_id: string }
        Returns: {
          cycle_date: string
          efficiency_percent: number
          is_free_demand: boolean
          lost_minutes: number
          minutes_on_during_peak: number
          post_peak_ok_count: number
          post_peak_startup_time: string
          pre_peak_ok_count: number
          pre_peak_shutdown_time: string
          pumps_on_during_peak: number
          pumps_operated: number
        }[]
      }
      get_energy_efficiency_pumps: {
        Args: { _date: string; _farm_id: string }
        Returns: {
          early_off_min: number
          equipment_id: string
          equipment_name: string
          first_on: string
          last_off: string
          late_min: number
          mode: string
          peak_minutes: number
          peak_violation: boolean
          post_status: string
          pre_status: string
        }[]
      }
      get_energy_efficiency_summary: {
        Args: { _farm_id: string }
        Returns: Json
      }
      get_farm_log_key: { Args: { _farm_id: string }; Returns: string }
      get_horimetro_daily: {
        Args: { _farm_id: string; _from: string; _to: string }
        Returns: {
          day: string
          equipment_id: string
          equipment_name: string
          hours: number
        }[]
      }
      get_horimetro_month_total: {
        Args: { _equipment_id: string; _farm_id: string }
        Returns: number
      }
      get_platform_admin_ids: { Args: never; Returns: string[] }
      get_water_balance: { Args: { _farm_id: string }; Returns: Json }
      has_farm_access: {
        Args: { _farm_id: string; _user_id: string }
        Returns: boolean
      }
      has_farm_role: {
        Args: {
          _farm_id: string
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      infer_pump_action_from_command_frame: {
        Args: { _frame: string; _saida: number }
        Returns: Database["public"]["Enums"]["event_action"]
      }
      ip_matches: { Args: { _ip: string; _pattern: string }; Returns: boolean }
      is_farm_admin: {
        Args: { _farm_id: string; _user_id: string }
        Returns: boolean
      }
      is_farm_in_maintenance: { Args: { _farm_id: string }; Returns: boolean }
      is_free_demand_day: {
        Args: { _date: string; _farm_id?: string }
        Returns: boolean
      }
      is_master_manager: { Args: { _uid: string }; Returns: boolean }
      is_platform_admin: { Args: { _user_id: string }; Returns: boolean }
      is_platform_staff: { Args: { _user_id: string }; Returns: boolean }
      is_platform_support: { Args: { _user_id: string }; Returns: boolean }
      is_whatsapp_approve_admin: { Args: { _uid: string }; Returns: boolean }
      is_whatsapp_register_admin: { Args: { _uid: string }; Returns: boolean }
      is_whatsapp_super_admin: { Args: { _uid: string }; Returns: boolean }
      license_register_device: {
        Args: {
          _agent_version?: string
          _fingerprint?: Json
          _ip_address?: string
          _license_key: string
          _machine_id_hash: string
        }
        Returns: Json
      }
      license_touch_heartbeat: {
        Args: {
          _agent_version?: string
          _device_id: string
          _machine_id_hash: string
        }
        Returns: Json
      }
      mark_agent_commands_expired: {
        Args: { _farm_id: string }
        Returns: number
      }
      mark_automation_command_failures: { Args: never; Returns: number }
      mark_commands_timeout: { Args: { _farm_id: string }; Returns: number }
      mark_disobeyed_commands_as_local: { Args: never; Returns: number }
      mark_pump_local_actuation: {
        Args: { _equipment_id: string; _farm_id: string }
        Returns: boolean
      }
      master_managers_overview: {
        Args: never
        Returns: {
          cpf: string
          created_at: string
          email: string
          farms_count: number
          full_name: string
          id: string
          status: string
          user_id: string
          whatsapp: string
        }[]
      }
      platform_alerts_feed: {
        Args: {
          p_category?: string
          p_farm_id?: string
          p_limit?: number
          p_severity?: string
          p_since?: string
          p_unread_only?: boolean
        }
        Returns: {
          alert_id: string
          category: string
          details: Json
          farm_id: string
          farm_name: string
          is_read: boolean
          message: string
          occurred_at: string
          severity: string
          source: string
          title: string
        }[]
      }
      platform_alerts_mark_all_read: {
        Args: { p_until?: string }
        Returns: number
      }
      platform_alerts_mark_read: {
        Args: { p_alert_id: string; p_source: string }
        Returns: undefined
      }
      platform_alerts_stats: { Args: never; Returns: Json }
      platform_assign_role: {
        Args: {
          _farm_id: string
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: undefined
      }
      platform_clear_pending_commands: {
        Args: { _farm_id: string }
        Returns: number
      }
      platform_create_farm: {
        Args: {
          _city?: string
          _name: string
          _owner_email?: string
          _plan?: string
          _state?: string
          _timezone?: string
        }
        Returns: Json
      }
      platform_create_farm_full: {
        Args: {
          _city?: string
          _name: string
          _owner_email: string
          _plan?: string
          _state?: string
          _timezone?: string
        }
        Returns: string
      }
      platform_farm_detail: { Args: { _farm_id: string }; Returns: Json }
      platform_farms_overview: {
        Args: never
        Returns: {
          agent_status: string
          city: string
          com_connected: boolean
          created_at: string
          equipments_count: number
          farm_id: string
          is_demo: boolean
          last_heartbeat: string
          license_key: string
          name: string
          pending_commands: number
          plan: string
          state: string
          users_count: number
        }[]
      }
      platform_generate_provisioning_token: {
        Args: { _farm_id: string; _notes?: string }
        Returns: Json
      }
      platform_get_devices_overview: {
        Args: never
        Returns: {
          activated_at: string
          agent_version: string
          device_id: string
          farm_id: string
          farm_name: string
          fingerprint: Json
          ip_address: string
          is_online: boolean
          last_seen_at: string
          machine_id_hash: string
          revoked_at: string
          revoked_reason: string
        }[]
      }
      platform_get_farm_trial: {
        Args: { _farm_id: string }
        Returns: {
          subscription_status: string
          trial_end_date: string
          trial_start_date: string
        }[]
      }
      platform_list_demo_farms: {
        Args: never
        Returns: {
          city: string
          description: string
          equipments_count: number
          farm_id: string
          name: string
          plan: string
          state: string
        }[]
      }
      platform_maintenance_activate: {
        Args: { _farm_id: string; _minutes?: number; _reason?: string }
        Returns: {
          activated_at: string
          activated_by: string | null
          expires_at: string
          farm_id: string
          reason: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "farm_maintenance_locks"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      platform_maintenance_release: {
        Args: { _farm_id: string }
        Returns: boolean
      }
      platform_overview_stats: { Args: never; Returns: Json }
      platform_regen_license: { Args: { _farm_id: string }; Returns: string }
      platform_remove_role: {
        Args: { _farm_id: string; _user_id: string }
        Returns: undefined
      }
      platform_reports_consolidated: {
        Args: { _from: string; _to: string }
        Returns: {
          agent_online: boolean
          alerts_critical: number
          alerts_warning: number
          automations_fired: number
          city: string
          commands_failed: number
          commands_success: number
          commands_total: number
          equipments_count: number
          farm_id: string
          farm_name: string
          last_heartbeat: string
          plan: string
          runtime_hours: number
          state: string
          users_count: number
        }[]
      }
      platform_reports_timeline: {
        Args: { p_since?: string; p_until?: string }
        Returns: {
          alerts_critical: number
          automations_fired: number
          commands_total: number
          day: string
        }[]
      }
      platform_revoke_provisioning_token: {
        Args: { _reason?: string; _token_id: string }
        Returns: boolean
      }
      platform_send_agent_reboot: {
        Args: { _farm_id: string }
        Returns: string
      }
      platform_send_farm_message: {
        Args: {
          _body: string
          _expires_at?: string
          _farm_id: string
          _level: string
          _title: string
        }
        Returns: string
      }
      platform_set_admin: {
        Args: { _enabled: boolean; _user_id: string }
        Returns: undefined
      }
      platform_set_farm_modules: {
        Args: { _farm_id: string; _modules: Json }
        Returns: Json
      }
      platform_set_farm_suspended: {
        Args: { _farm_id: string; _suspended: boolean }
        Returns: undefined
      }
      platform_set_farm_trial: {
        Args: {
          _farm_id: string
          _subscription_status?: string
          _trial_end?: string
          _trial_start?: string
        }
        Returns: undefined
      }
      platform_set_support: {
        Args: { _enabled: boolean; _user_id: string }
        Returns: undefined
      }
      platform_toggle_suspend: {
        Args: { _farm_id: string; _suspend: boolean }
        Returns: undefined
      }
      platform_unbind_device: {
        Args: { _device_id: string; _reason?: string }
        Returns: undefined
      }
      platform_update_farm: {
        Args: {
          _city?: string
          _farm_id: string
          _license_key?: string
          _name?: string
          _plan?: string
          _state?: string
        }
        Returns: undefined
      }
      platform_user_detail: { Args: { _user_id: string }; Returns: Json }
      platform_users_overview: {
        Args: never
        Returns: {
          created_at: string
          email: string
          farms: Json
          farms_count: number
          full_name: string
          is_platform_admin: boolean
          is_platform_support: boolean
          last_sign_in_at: string
          phone: string
          user_id: string
        }[]
      }
      pump_lock_overlap_minutes: {
        Args: {
          _equipment_id: string
          _farm_id: string
          _from: string
          _to: string
        }
        Returns: number
      }
      purge_stale_on_commands_when_bridge_down: {
        Args: never
        Returns: {
          cancelled_count: number
          farm_id: string
        }[]
      }
      renov_combined_payload: {
        Args: {
          _current_state: string
          _saida: number
          _total: number
          _turn_on: boolean
        }
        Returns: string
      }
      renov_positional_payload: {
        Args: { _saida: number; _turn_on: boolean }
        Returns: string
      }
      request_agent_update: {
        Args: { _farm_id: string; _force?: boolean; _version: string }
        Returns: Json
      }
      reset_agent_hardware: { Args: { _farm_id: string }; Returns: undefined }
      resolve_automation_actor_label: {
        Args: {
          _details: Json
          _origin: Database["public"]["Enums"]["event_origin"]
          _source_device: string
          _user_email: string
          _user_id: string
        }
        Returns: string
      }
      resolve_user_display_name: { Args: { _uid: string }; Returns: string }
      run_automacoes_tick: {
        Args: never
        Returns: {
          actions_enqueued: number
          fired: number
        }[]
      }
      run_automation_tick: {
        Args: never
        Returns: {
          enqueued_count: number
          schedules_evaluated: number
        }[]
      }
      run_peak_hour_tick: {
        Args: never
        Returns: {
          off_enqueued: number
          on_enqueued: number
        }[]
      }
      send_security_alert_whatsapp: {
        Args: { _alert_id: string }
        Returns: undefined
      }
      sweep_stuck_pump_commands: { Args: never; Returns: number }
      touch_active_session: { Args: { _session_id: string }; Returns: boolean }
      update_flow_from_telemetry: {
        Args: { _farm_id: string; _raw: string; _tsnn: string }
        Returns: undefined
      }
    }
    Enums: {
      agent_cmd_kind:
        | "close_port"
        | "open_port"
        | "change_port"
        | "hard_reset_bridge"
        | "set_log_level"
        | "send_manual_frame"
        | "pause_polling"
        | "resume_polling"
        | "list_ports"
        | "update_agent"
        | "agent_restart"
        | "force_reboot"
        | "force_rollback"
        | "start_log_stream"
        | "renew_log_stream"
        | "stop_log_stream"
      agent_cmd_status:
        | "pending"
        | "ack"
        | "executing"
        | "done"
        | "error"
        | "expired"
      app_role: "owner" | "admin" | "operator" | "viewer" | "supervisor"
      command_status:
        | "pending"
        | "sent"
        | "delivered"
        | "executed"
        | "timeout"
        | "error"
        | "cancelled"
      command_type:
        | "polling"
        | "manual"
        | "config"
        | "server"
        | "repeater"
        | "diagnostic"
        | "service_test"
        | "automation"
      equipment_type: "poco" | "bombeamento" | "nivel" | "repetidor"
      event_action:
        | "turn_on"
        | "turn_off"
        | "status_read"
        | "mode_change"
        | "reset"
        | "polling"
        | "pump_on"
        | "pump_off"
      event_origin: "remote" | "local" | "auto" | "reading" | "system"
      event_result: "success" | "fail" | "pending" | "timeout"
      tampering_kind:
        | "asar_modified"
        | "hardware_changed"
        | "config_replaced"
        | "integrity_check_failed"
        | "unsigned_binary"
        | "other"
      tampering_level: "info" | "warn" | "critical"
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
  public: {
    Enums: {
      agent_cmd_kind: [
        "close_port",
        "open_port",
        "change_port",
        "hard_reset_bridge",
        "set_log_level",
        "send_manual_frame",
        "pause_polling",
        "resume_polling",
        "list_ports",
        "update_agent",
        "agent_restart",
        "force_reboot",
        "force_rollback",
        "start_log_stream",
        "renew_log_stream",
        "stop_log_stream",
      ],
      agent_cmd_status: [
        "pending",
        "ack",
        "executing",
        "done",
        "error",
        "expired",
      ],
      app_role: ["owner", "admin", "operator", "viewer", "supervisor"],
      command_status: [
        "pending",
        "sent",
        "delivered",
        "executed",
        "timeout",
        "error",
        "cancelled",
      ],
      command_type: [
        "polling",
        "manual",
        "config",
        "server",
        "repeater",
        "diagnostic",
        "service_test",
        "automation",
      ],
      equipment_type: ["poco", "bombeamento", "nivel", "repetidor"],
      event_action: [
        "turn_on",
        "turn_off",
        "status_read",
        "mode_change",
        "reset",
        "polling",
        "pump_on",
        "pump_off",
      ],
      event_origin: ["remote", "local", "auto", "reading", "system"],
      event_result: ["success", "fail", "pending", "timeout"],
      tampering_kind: [
        "asar_modified",
        "hardware_changed",
        "config_replaced",
        "integrity_check_failed",
        "unsigned_binary",
        "other",
      ],
      tampering_level: ["info", "warn", "critical"],
    },
  },
} as const
