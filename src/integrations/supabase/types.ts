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
      agent_release_keys: {
        Row: {
          aes_key: string
          algo: string
          created_at: string
          version: string
        }
        Insert: {
          aes_key: string
          algo?: string
          created_at?: string
          version: string
        }
        Update: {
          aes_key?: string
          algo?: string
          created_at?: string
          version?: string
        }
        Relationships: []
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
      agent_security_events: {
        Row: {
          agent_version: string | null
          created_at: string
          details: Json
          device_id: string | null
          event_type: string
          farm_id: string | null
          id: string
          ip_address: string | null
          machine_id_hash: string | null
          severity: string
        }
        Insert: {
          agent_version?: string | null
          created_at?: string
          details?: Json
          device_id?: string | null
          event_type: string
          farm_id?: string | null
          id?: string
          ip_address?: string | null
          machine_id_hash?: string | null
          severity?: string
        }
        Update: {
          agent_version?: string | null
          created_at?: string
          details?: Json
          device_id?: string | null
          event_type?: string
          farm_id?: string | null
          id?: string
          ip_address?: string | null
          machine_id_hash?: string | null
          severity?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_security_events_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_technical_events: {
        Row: {
          created_at: string
          details: Json
          equipment_id: string | null
          equipment_name: string | null
          farm_id: string
          id: string
          kind: string
          occurred_at: string
        }
        Insert: {
          created_at?: string
          details?: Json
          equipment_id?: string | null
          equipment_name?: string | null
          farm_id: string
          id?: string
          kind: string
          occurred_at?: string
        }
        Update: {
          created_at?: string
          details?: Json
          equipment_id?: string | null
          equipment_name?: string | null
          farm_id?: string
          id?: string
          kind?: string
          occurred_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_technical_events_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
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
      authorship_pending_review: {
        Row: {
          automation_log_id: string
          created_at: string
          equipment_id: string | null
          equipment_name: string | null
          farm_id: string
          id: string
          occurred_at: string | null
          origin: string | null
          reason: string
          resolved_at: string | null
          resolved_by: string | null
        }
        Insert: {
          automation_log_id: string
          created_at?: string
          equipment_id?: string | null
          equipment_name?: string | null
          farm_id: string
          id?: string
          occurred_at?: string | null
          origin?: string | null
          reason: string
          resolved_at?: string | null
          resolved_by?: string | null
        }
        Update: {
          automation_log_id?: string
          created_at?: string
          equipment_id?: string | null
          equipment_name?: string | null
          farm_id?: string
          id?: string
          occurred_at?: string | null
          origin?: string | null
          reason?: string
          resolved_at?: string | null
          resolved_by?: string | null
        }
        Relationships: []
      }
      authorship_reconciliation_batches: {
        Row: {
          applied_actor: string | null
          applied_at: string
          applied_by: string | null
          applied_email: string | null
          applied_user: string | null
          batch_id: string
          candidate_confidence: string | null
          candidate_source: string | null
          confidence: string | null
          ended_at: string
          event_ids: string[]
          events_total: number
          evidence: string | null
          farm_id: string
          id: string
          intent: string
          requires_admin_decision: boolean
          source: string
          started_at: string
        }
        Insert: {
          applied_actor?: string | null
          applied_at?: string
          applied_by?: string | null
          applied_email?: string | null
          applied_user?: string | null
          batch_id: string
          candidate_confidence?: string | null
          candidate_source?: string | null
          confidence?: string | null
          ended_at: string
          event_ids: string[]
          events_total: number
          evidence?: string | null
          farm_id: string
          id?: string
          intent: string
          requires_admin_decision?: boolean
          source?: string
          started_at: string
        }
        Update: {
          applied_actor?: string | null
          applied_at?: string
          applied_by?: string | null
          applied_email?: string | null
          applied_user?: string | null
          batch_id?: string
          candidate_confidence?: string | null
          candidate_source?: string | null
          confidence?: string | null
          ended_at?: string
          event_ids?: string[]
          events_total?: number
          evidence?: string | null
          farm_id?: string
          id?: string
          intent?: string
          requires_admin_decision?: boolean
          source?: string
          started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "authorship_reconciliation_batches_farm_id_fkey"
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
      automation_cleanup_audit: {
        Row: {
          action: string
          after_value: Json
          before_value: Json
          confidence: string | null
          equipment_id: string | null
          event_id: string
          evidence: Json
          evidence_source: string | null
          executed_at: string
          executed_by: string
          farm_id: string | null
          id: number
          phase_a_category: string
          reason: string
          run_id: string
        }
        Insert: {
          action: string
          after_value?: Json
          before_value?: Json
          confidence?: string | null
          equipment_id?: string | null
          event_id: string
          evidence?: Json
          evidence_source?: string | null
          executed_at?: string
          executed_by: string
          farm_id?: string | null
          id?: number
          phase_a_category: string
          reason: string
          run_id: string
        }
        Update: {
          action?: string
          after_value?: Json
          before_value?: Json
          confidence?: string | null
          equipment_id?: string | null
          event_id?: string
          evidence?: Json
          evidence_source?: string | null
          executed_at?: string
          executed_by?: string
          farm_id?: string | null
          id?: number
          phase_a_category?: string
          reason?: string
          run_id?: string
        }
        Relationships: []
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
          noise_reason: string | null
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
          noise_reason?: string | null
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
          noise_reason?: string | null
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
      automation_log_authorship_report: {
        Row: {
          com_autor_ok: number
          farm_id: string
          farm_name: string | null
          id: string
          pendencias: number
          recuperados_command_audit: number
          recuperados_details: number
          recuperados_last_changed_by: number
          remotos_total: number
          rotulos_tecnicos_removidos: number
          ruido_excluido: number
          run_at: string
          run_id: string
        }
        Insert: {
          com_autor_ok?: number
          farm_id: string
          farm_name?: string | null
          id?: string
          pendencias?: number
          recuperados_command_audit?: number
          recuperados_details?: number
          recuperados_last_changed_by?: number
          remotos_total?: number
          rotulos_tecnicos_removidos?: number
          ruido_excluido?: number
          run_at?: string
          run_id: string
        }
        Update: {
          com_autor_ok?: number
          farm_id?: string
          farm_name?: string | null
          id?: string
          pendencias?: number
          recuperados_command_audit?: number
          recuperados_details?: number
          recuperados_last_changed_by?: number
          remotos_total?: number
          rotulos_tecnicos_removidos?: number
          ruido_excluido?: number
          run_at?: string
          run_id?: string
        }
        Relationships: []
      }
      automation_log_cleanup_report: {
        Row: {
          after_count: number
          batch_order: number
          before_count: number
          equipment_id: string | null
          equipment_name: string | null
          farm_id: string
          farm_name: string | null
          id: string
          removed_no_equipment: number
          removed_not_confirmed: number
          removed_reading: number
          removed_repeated: number
          removed_total: number
          run_at: string
          run_id: string
        }
        Insert: {
          after_count: number
          batch_order: number
          before_count: number
          equipment_id?: string | null
          equipment_name?: string | null
          farm_id: string
          farm_name?: string | null
          id?: string
          removed_no_equipment?: number
          removed_not_confirmed?: number
          removed_reading?: number
          removed_repeated?: number
          removed_total?: number
          run_at?: string
          run_id: string
        }
        Update: {
          after_count?: number
          batch_order?: number
          before_count?: number
          equipment_id?: string | null
          equipment_name?: string | null
          farm_id?: string
          farm_name?: string | null
          id?: string
          removed_no_equipment?: number
          removed_not_confirmed?: number
          removed_reading?: number
          removed_repeated?: number
          removed_total?: number
          run_at?: string
          run_id?: string
        }
        Relationships: []
      }
      automation_log_noise_stats: {
        Row: {
          day: string
          equipment_id: string
          farm_id: string
          hits: number
          reason: string
          updated_at: string
        }
        Insert: {
          day: string
          equipment_id: string
          farm_id: string
          hits?: number
          reason: string
          updated_at?: string
        }
        Update: {
          day?: string
          equipment_id?: string
          farm_id?: string
          hits?: number
          reason?: string
          updated_at?: string
        }
        Relationships: []
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
      billing_charges: {
        Row: {
          amount_cents: number
          competence_month: string
          contract_id: string
          created_at: string
          customer_id: string
          discount_cents: number
          due_date: string
          fine_cents: number
          id: string
          idempotency_key: string
          interest_cents: number
          paid_at: string | null
          status: Database["public"]["Enums"]["billing_charge_status"]
          total_cents: number | null
          updated_at: string
        }
        Insert: {
          amount_cents: number
          competence_month: string
          contract_id: string
          created_at?: string
          customer_id: string
          discount_cents?: number
          due_date: string
          fine_cents?: number
          id?: string
          idempotency_key: string
          interest_cents?: number
          paid_at?: string | null
          status?: Database["public"]["Enums"]["billing_charge_status"]
          total_cents?: number | null
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          competence_month?: string
          contract_id?: string
          created_at?: string
          customer_id?: string
          discount_cents?: number
          due_date?: string
          fine_cents?: number
          id?: string
          idempotency_key?: string
          interest_cents?: number
          paid_at?: string | null
          status?: Database["public"]["Enums"]["billing_charge_status"]
          total_cents?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_charges_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "billing_contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_charges_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "billing_customer_status"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "billing_charges_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "billing_customers"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_contract_farms: {
        Row: {
          contract_id: string
          created_at: string
          customer_id: string
          farm_id: string
        }
        Insert: {
          contract_id: string
          created_at?: string
          customer_id: string
          farm_id: string
        }
        Update: {
          contract_id?: string
          created_at?: string
          customer_id?: string
          farm_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_contract_farms_contract_fk"
            columns: ["contract_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "billing_contracts"
            referencedColumns: ["id", "customer_id"]
          },
          {
            foreignKeyName: "billing_contract_farms_customer_farm_fk"
            columns: ["customer_id", "farm_id"]
            isOneToOne: false
            referencedRelation: "billing_customer_farms"
            referencedColumns: ["customer_id", "farm_id"]
          },
        ]
      }
      billing_contracts: {
        Row: {
          adjustment_index: Database["public"]["Enums"]["billing_adjustment_index"]
          adjustment_month: number | null
          amount_cents: number
          auto_charge: boolean
          auto_invoice: boolean
          auto_issue_charge: boolean
          billing_type: Database["public"]["Enums"]["billing_type"]
          created_at: string
          created_by: string | null
          currency: string
          customer_id: string
          description: string
          due_day: number
          end_date: string | null
          id: string
          notes: string | null
          payment_method_preference:
            | Database["public"]["Enums"]["billing_payment_method"]
            | null
          periodicity: Database["public"]["Enums"]["billing_periodicity"]
          start_date: string
          status: Database["public"]["Enums"]["billing_contract_status"]
          updated_at: string
        }
        Insert: {
          adjustment_index?: Database["public"]["Enums"]["billing_adjustment_index"]
          adjustment_month?: number | null
          amount_cents: number
          auto_charge?: boolean
          auto_invoice?: boolean
          auto_issue_charge?: boolean
          billing_type: Database["public"]["Enums"]["billing_type"]
          created_at?: string
          created_by?: string | null
          currency?: string
          customer_id: string
          description: string
          due_day?: number
          end_date?: string | null
          id?: string
          notes?: string | null
          payment_method_preference?:
            | Database["public"]["Enums"]["billing_payment_method"]
            | null
          periodicity?: Database["public"]["Enums"]["billing_periodicity"]
          start_date: string
          status?: Database["public"]["Enums"]["billing_contract_status"]
          updated_at?: string
        }
        Update: {
          adjustment_index?: Database["public"]["Enums"]["billing_adjustment_index"]
          adjustment_month?: number | null
          amount_cents?: number
          auto_charge?: boolean
          auto_invoice?: boolean
          auto_issue_charge?: boolean
          billing_type?: Database["public"]["Enums"]["billing_type"]
          created_at?: string
          created_by?: string | null
          currency?: string
          customer_id?: string
          description?: string
          due_day?: number
          end_date?: string | null
          id?: string
          notes?: string | null
          payment_method_preference?:
            | Database["public"]["Enums"]["billing_payment_method"]
            | null
          periodicity?: Database["public"]["Enums"]["billing_periodicity"]
          start_date?: string
          status?: Database["public"]["Enums"]["billing_contract_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_contracts_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "billing_customer_status"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "billing_contracts_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "billing_customers"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_customer_farms: {
        Row: {
          created_at: string
          customer_id: string
          farm_id: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          farm_id: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          farm_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_customer_farms_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "billing_customer_status"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "billing_customer_farms_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "billing_customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_customer_farms_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_customers: {
        Row: {
          city: string | null
          created_at: string
          created_by: string | null
          doc_number: string
          doc_type: Database["public"]["Enums"]["billing_doc_type"]
          email_billing: string | null
          endereco: string | null
          id: string
          legal_name: string
          notes: string | null
          phone_billing: string | null
          state: string | null
          status: Database["public"]["Enums"]["billing_customer_state"]
          trade_name: string | null
          updated_at: string
          whatsapp_billing: string | null
          zip_code: string | null
        }
        Insert: {
          city?: string | null
          created_at?: string
          created_by?: string | null
          doc_number: string
          doc_type: Database["public"]["Enums"]["billing_doc_type"]
          email_billing?: string | null
          endereco?: string | null
          id?: string
          legal_name: string
          notes?: string | null
          phone_billing?: string | null
          state?: string | null
          status?: Database["public"]["Enums"]["billing_customer_state"]
          trade_name?: string | null
          updated_at?: string
          whatsapp_billing?: string | null
          zip_code?: string | null
        }
        Update: {
          city?: string | null
          created_at?: string
          created_by?: string | null
          doc_number?: string
          doc_type?: Database["public"]["Enums"]["billing_doc_type"]
          email_billing?: string | null
          endereco?: string | null
          id?: string
          legal_name?: string
          notes?: string | null
          phone_billing?: string | null
          state?: string | null
          status?: Database["public"]["Enums"]["billing_customer_state"]
          trade_name?: string | null
          updated_at?: string
          whatsapp_billing?: string | null
          zip_code?: string | null
        }
        Relationships: []
      }
      billing_events: {
        Row: {
          actor_kind: Database["public"]["Enums"]["billing_actor_kind"]
          actor_user_id: string | null
          after: Json | null
          before: Json | null
          entity_id: string | null
          entity_type: string
          event: string
          id: number
          occurred_at: string
          provider: string | null
        }
        Insert: {
          actor_kind?: Database["public"]["Enums"]["billing_actor_kind"]
          actor_user_id?: string | null
          after?: Json | null
          before?: Json | null
          entity_id?: string | null
          entity_type: string
          event: string
          id?: number
          occurred_at?: string
          provider?: string | null
        }
        Update: {
          actor_kind?: Database["public"]["Enums"]["billing_actor_kind"]
          actor_user_id?: string | null
          after?: Json | null
          before?: Json | null
          entity_id?: string | null
          entity_type?: string
          event?: string
          id?: number
          occurred_at?: string
          provider?: string | null
        }
        Relationships: []
      }
      billing_import_jobs: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          column_mapping: Json
          committed_at: string | null
          created_at: string
          created_by: string | null
          duplicate_rows: number
          error: string | null
          id: string
          invalid_rows: number
          kind: Database["public"]["Enums"]["billing_import_kind"]
          mime: string | null
          parsed_at: string | null
          source_bytes: number
          source_filename: string
          source_sha256: string
          status: Database["public"]["Enums"]["billing_import_status"]
          summary: Json
          total_rows: number
          valid_rows: number
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          column_mapping?: Json
          committed_at?: string | null
          created_at?: string
          created_by?: string | null
          duplicate_rows?: number
          error?: string | null
          id?: string
          invalid_rows?: number
          kind?: Database["public"]["Enums"]["billing_import_kind"]
          mime?: string | null
          parsed_at?: string | null
          source_bytes: number
          source_filename: string
          source_sha256: string
          status?: Database["public"]["Enums"]["billing_import_status"]
          summary?: Json
          total_rows?: number
          valid_rows?: number
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          column_mapping?: Json
          committed_at?: string | null
          created_at?: string
          created_by?: string | null
          duplicate_rows?: number
          error?: string | null
          id?: string
          invalid_rows?: number
          kind?: Database["public"]["Enums"]["billing_import_kind"]
          mime?: string | null
          parsed_at?: string | null
          source_bytes?: number
          source_filename?: string
          source_sha256?: string
          status?: Database["public"]["Enums"]["billing_import_status"]
          summary?: Json
          total_rows?: number
          valid_rows?: number
        }
        Relationships: []
      }
      billing_import_rows: {
        Row: {
          created_at: string
          created_entity_id: string | null
          created_entity_type: string | null
          duplicate_of_charge_id: string | null
          duplicate_of_contract_id: string | null
          duplicate_of_customer_id: string | null
          id: string
          job_id: string
          mapped: Json
          match_customer_id: string | null
          match_farm_id: string | null
          raw: Json
          reject_reason: string | null
          row_number: number
          row_status: Database["public"]["Enums"]["billing_import_row_status"]
          validation: Json
        }
        Insert: {
          created_at?: string
          created_entity_id?: string | null
          created_entity_type?: string | null
          duplicate_of_charge_id?: string | null
          duplicate_of_contract_id?: string | null
          duplicate_of_customer_id?: string | null
          id?: string
          job_id: string
          mapped?: Json
          match_customer_id?: string | null
          match_farm_id?: string | null
          raw?: Json
          reject_reason?: string | null
          row_number: number
          row_status?: Database["public"]["Enums"]["billing_import_row_status"]
          validation?: Json
        }
        Update: {
          created_at?: string
          created_entity_id?: string | null
          created_entity_type?: string | null
          duplicate_of_charge_id?: string | null
          duplicate_of_contract_id?: string | null
          duplicate_of_customer_id?: string | null
          id?: string
          job_id?: string
          mapped?: Json
          match_customer_id?: string | null
          match_farm_id?: string | null
          raw?: Json
          reject_reason?: string | null
          row_number?: number
          row_status?: Database["public"]["Enums"]["billing_import_row_status"]
          validation?: Json
        }
        Relationships: [
          {
            foreignKeyName: "billing_import_rows_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "billing_import_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_import_rows_match_customer_id_fkey"
            columns: ["match_customer_id"]
            isOneToOne: false
            referencedRelation: "billing_customer_status"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "billing_import_rows_match_customer_id_fkey"
            columns: ["match_customer_id"]
            isOneToOne: false
            referencedRelation: "billing_customers"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_payment_methods: {
        Row: {
          authorization_id: string | null
          authorized_at: string | null
          created_at: string
          created_by: string | null
          currency: string
          customer_id: string
          display_brand: string | null
          display_last4: string | null
          expires_at: string | null
          id: string
          kind: Database["public"]["Enums"]["billing_payment_method"]
          max_amount_cents: number | null
          metadata: Json
          periodicity: Database["public"]["Enums"]["billing_periodicity"] | null
          provider: string | null
          provider_customer_id: string | null
          provider_payment_method_id: string | null
          revoked_at: string | null
          status: Database["public"]["Enums"]["billing_method_status"]
          updated_at: string
        }
        Insert: {
          authorization_id?: string | null
          authorized_at?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          customer_id: string
          display_brand?: string | null
          display_last4?: string | null
          expires_at?: string | null
          id?: string
          kind: Database["public"]["Enums"]["billing_payment_method"]
          max_amount_cents?: number | null
          metadata?: Json
          periodicity?:
            | Database["public"]["Enums"]["billing_periodicity"]
            | null
          provider?: string | null
          provider_customer_id?: string | null
          provider_payment_method_id?: string | null
          revoked_at?: string | null
          status?: Database["public"]["Enums"]["billing_method_status"]
          updated_at?: string
        }
        Update: {
          authorization_id?: string | null
          authorized_at?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          customer_id?: string
          display_brand?: string | null
          display_last4?: string | null
          expires_at?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["billing_payment_method"]
          max_amount_cents?: number | null
          metadata?: Json
          periodicity?:
            | Database["public"]["Enums"]["billing_periodicity"]
            | null
          provider?: string | null
          provider_customer_id?: string | null
          provider_payment_method_id?: string | null
          revoked_at?: string | null
          status?: Database["public"]["Enums"]["billing_method_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_payment_methods_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "billing_customer_status"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "billing_payment_methods_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "billing_customers"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_payments: {
        Row: {
          amount_cents: number
          boleto_barcode: string | null
          boleto_line: string | null
          boleto_our_number: string | null
          charge_id: string
          created_at: string
          expires_at: string | null
          id: string
          kind: Database["public"]["Enums"]["billing_payment_kind"]
          method: Database["public"]["Enums"]["billing_payment_method"]
          notes: string | null
          paid_at: string
          payment_method_id: string | null
          payment_origin: Database["public"]["Enums"]["billing_payment_origin"]
          pix_end_to_end_id: string | null
          pix_txid: string | null
          provider: string | null
          provider_metadata: Json
          provider_payment_id: string | null
          provider_reference: string | null
          provider_status: string | null
          provider_transaction_id: string | null
          raw_payload: Json
          reconciled_by: Database["public"]["Enums"]["billing_actor_kind"]
          reconciled_by_user: string | null
          reverses_payment_id: string | null
          status: Database["public"]["Enums"]["billing_payment_status"]
        }
        Insert: {
          amount_cents: number
          boleto_barcode?: string | null
          boleto_line?: string | null
          boleto_our_number?: string | null
          charge_id: string
          created_at?: string
          expires_at?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["billing_payment_kind"]
          method: Database["public"]["Enums"]["billing_payment_method"]
          notes?: string | null
          paid_at: string
          payment_method_id?: string | null
          payment_origin?: Database["public"]["Enums"]["billing_payment_origin"]
          pix_end_to_end_id?: string | null
          pix_txid?: string | null
          provider?: string | null
          provider_metadata?: Json
          provider_payment_id?: string | null
          provider_reference?: string | null
          provider_status?: string | null
          provider_transaction_id?: string | null
          raw_payload?: Json
          reconciled_by?: Database["public"]["Enums"]["billing_actor_kind"]
          reconciled_by_user?: string | null
          reverses_payment_id?: string | null
          status?: Database["public"]["Enums"]["billing_payment_status"]
        }
        Update: {
          amount_cents?: number
          boleto_barcode?: string | null
          boleto_line?: string | null
          boleto_our_number?: string | null
          charge_id?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["billing_payment_kind"]
          method?: Database["public"]["Enums"]["billing_payment_method"]
          notes?: string | null
          paid_at?: string
          payment_method_id?: string | null
          payment_origin?: Database["public"]["Enums"]["billing_payment_origin"]
          pix_end_to_end_id?: string | null
          pix_txid?: string | null
          provider?: string | null
          provider_metadata?: Json
          provider_payment_id?: string | null
          provider_reference?: string | null
          provider_status?: string | null
          provider_transaction_id?: string | null
          raw_payload?: Json
          reconciled_by?: Database["public"]["Enums"]["billing_actor_kind"]
          reconciled_by_user?: string | null
          reverses_payment_id?: string | null
          status?: Database["public"]["Enums"]["billing_payment_status"]
        }
        Relationships: [
          {
            foreignKeyName: "billing_payments_charge_id_fkey"
            columns: ["charge_id"]
            isOneToOne: false
            referencedRelation: "billing_charges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_payments_payment_method_id_fkey"
            columns: ["payment_method_id"]
            isOneToOne: false
            referencedRelation: "billing_payment_methods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_payments_reverses_payment_id_fkey"
            columns: ["reverses_payment_id"]
            isOneToOne: false
            referencedRelation: "billing_payments"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_roles: {
        Row: {
          created_at: string
          created_by: string | null
          notes: string | null
          role: Database["public"]["Enums"]["billing_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          notes?: string | null
          role: Database["public"]["Enums"]["billing_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          notes?: string | null
          role?: Database["public"]["Enums"]["billing_role"]
          user_id?: string
        }
        Relationships: []
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
      command_audit: {
        Row: {
          actor_label: string | null
          captured_at: string
          client_event_id: string | null
          command_created_at: string | null
          command_id: string
          details: Json
          equipment_id: string | null
          equipment_name: string | null
          farm_id: string
          frame: string | null
          id: string
          intent: string | null
          origin_kind: string | null
          responded_at: string | null
          sent_at: string | null
          source_device: string | null
          status_final: string | null
          user_email: string | null
          user_id: string | null
        }
        Insert: {
          actor_label?: string | null
          captured_at?: string
          client_event_id?: string | null
          command_created_at?: string | null
          command_id: string
          details?: Json
          equipment_id?: string | null
          equipment_name?: string | null
          farm_id: string
          frame?: string | null
          id?: string
          intent?: string | null
          origin_kind?: string | null
          responded_at?: string | null
          sent_at?: string | null
          source_device?: string | null
          status_final?: string | null
          user_email?: string | null
          user_id?: string | null
        }
        Update: {
          actor_label?: string | null
          captured_at?: string
          client_event_id?: string | null
          command_created_at?: string | null
          command_id?: string
          details?: Json
          equipment_id?: string | null
          equipment_name?: string | null
          farm_id?: string
          frame?: string | null
          id?: string
          intent?: string | null
          origin_kind?: string | null
          responded_at?: string | null
          sent_at?: string | null
          source_device?: string | null
          status_final?: string | null
          user_email?: string | null
          user_id?: string | null
        }
        Relationships: []
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
          idempotency_key: string | null
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
          idempotency_key?: string | null
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
          idempotency_key?: string | null
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
      cron_job_backup: {
        Row: {
          backed_up_at: string
          command: string
          id: number
          jobname: string
          schedule: string
        }
        Insert: {
          backed_up_at?: string
          command: string
          id?: number
          jobname: string
          schedule: string
        }
        Update: {
          backed_up_at?: string
          command?: string
          id?: number
          jobname?: string
          schedule?: string
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
          current_token_expires_at: string | null
          current_token_jti: string | null
          farm_id: string
          fingerprint: Json
          fingerprint_mismatch_count: number | null
          id: string
          ip_address: string | null
          last_fingerprint_check: string | null
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
          current_token_expires_at?: string | null
          current_token_jti?: string | null
          farm_id: string
          fingerprint?: Json
          fingerprint_mismatch_count?: number | null
          id?: string
          ip_address?: string | null
          last_fingerprint_check?: string | null
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
          current_token_expires_at?: string | null
          current_token_jti?: string | null
          farm_id?: string
          fingerprint?: Json
          fingerprint_mismatch_count?: number | null
          id?: string
          ip_address?: string | null
          last_fingerprint_check?: string | null
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
      environmental_agencies: {
        Row: {
          agency_acronym: string
          agency_name: string
          agency_website: string | null
          id: string
          notes: string | null
          report_format: string | null
          state_code: string
          state_name: string
        }
        Insert: {
          agency_acronym: string
          agency_name: string
          agency_website?: string | null
          id?: string
          notes?: string | null
          report_format?: string | null
          state_code: string
          state_name: string
        }
        Update: {
          agency_acronym?: string
          agency_name?: string
          agency_website?: string | null
          id?: string
          notes?: string | null
          report_format?: string | null
          state_code?: string
          state_name?: string
        }
        Relationships: []
      }
      equipments: {
        Row: {
          active: boolean
          alarm_high: number | null
          alarm_low: number | null
          alimenta_alt_id: string | null
          alimenta_id: string | null
          auto_mode: boolean
          automatic_on_attempt_since: string | null
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
          forced_shutdown_enabled: boolean
          horas_pico: string | null
          hw_id: string
          id: string
          is_captacao: boolean
          last_actuation_origin: string | null
          last_actuation_rule: string | null
          last_changed_by: string | null
          last_communication: string | null
          last_confirmed_state: number
          last_confirmed_transition_at: string | null
          last_confirmed_transition_state: boolean | null
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
          switching_protection_enabled: boolean
          switching_protection_seconds: number | null
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
          alimenta_alt_id?: string | null
          alimenta_id?: string | null
          auto_mode?: boolean
          automatic_on_attempt_since?: string | null
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
          forced_shutdown_enabled?: boolean
          horas_pico?: string | null
          hw_id: string
          id?: string
          is_captacao?: boolean
          last_actuation_origin?: string | null
          last_actuation_rule?: string | null
          last_changed_by?: string | null
          last_communication?: string | null
          last_confirmed_state?: number
          last_confirmed_transition_at?: string | null
          last_confirmed_transition_state?: boolean | null
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
          switching_protection_enabled?: boolean
          switching_protection_seconds?: number | null
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
          alimenta_alt_id?: string | null
          alimenta_id?: string | null
          auto_mode?: boolean
          automatic_on_attempt_since?: string | null
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
          forced_shutdown_enabled?: boolean
          horas_pico?: string | null
          hw_id?: string
          id?: string
          is_captacao?: boolean
          last_actuation_origin?: string | null
          last_actuation_rule?: string | null
          last_changed_by?: string | null
          last_communication?: string | null
          last_confirmed_state?: number
          last_confirmed_transition_at?: string | null
          last_confirmed_transition_state?: boolean | null
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
          switching_protection_enabled?: boolean
          switching_protection_seconds?: number | null
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
            foreignKeyName: "equipments_alimenta_alt_id_fkey"
            columns: ["alimenta_alt_id"]
            isOneToOne: false
            referencedRelation: "equipments"
            referencedColumns: ["id"]
          },
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
      export_log: {
        Row: {
          created_at: string
          farm_id: string | null
          format: string
          id: string
          metadata: Json
          report_type: string
          row_count: number
          user_id: string | null
        }
        Insert: {
          created_at?: string
          farm_id?: string | null
          format: string
          id?: string
          metadata?: Json
          report_type: string
          row_count?: number
          user_id?: string | null
        }
        Update: {
          created_at?: string
          farm_id?: string | null
          format?: string
          id?: string
          metadata?: Json
          report_type?: string
          row_count?: number
          user_id?: string | null
        }
        Relationships: []
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
      farm_notifications_purged: {
        Row: {
          created_at: string | null
          equipment_id: string | null
          evidencia: Json
          farm_id: string
          id: string
          kind: string | null
          message: string | null
          purge_reason: string
          purged_at: string
          resolved_at: string | null
          severity: string | null
          source: string | null
          source_ref: string | null
          title: string | null
        }
        Insert: {
          created_at?: string | null
          equipment_id?: string | null
          evidencia?: Json
          farm_id: string
          id: string
          kind?: string | null
          message?: string | null
          purge_reason: string
          purged_at?: string
          resolved_at?: string | null
          severity?: string | null
          source?: string | null
          source_ref?: string | null
          title?: string | null
        }
        Update: {
          created_at?: string | null
          equipment_id?: string | null
          evidencia?: Json
          farm_id?: string
          id?: string
          kind?: string | null
          message?: string | null
          purge_reason?: string
          purged_at?: string
          resolved_at?: string | null
          severity?: string | null
          source?: string | null
          source_ref?: string | null
          title?: string | null
        }
        Relationships: []
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
          operadores_reduzidos: number
          peak_hour_end: string
          peak_hour_start: string
          remote_operation_time_minutes: number
          reserved_hour_end: string
          reserved_hour_start: string
          salario_medio_regional: number
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
          valor_safra_r_per_m3: number
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
          operadores_reduzidos?: number
          peak_hour_end?: string
          peak_hour_start?: string
          remote_operation_time_minutes?: number
          reserved_hour_end?: string
          reserved_hour_start?: string
          salario_medio_regional?: number
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
          valor_safra_r_per_m3?: number
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
          operadores_reduzidos?: number
          peak_hour_end?: string
          peak_hour_start?: string
          remote_operation_time_minutes?: number
          reserved_hour_end?: string
          reserved_hour_start?: string
          salario_medio_regional?: number
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
          valor_safra_r_per_m3?: number
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
          automatic_start_batch_size: number
          automatic_start_stagger_enabled: boolean
          automatic_start_stagger_seconds: number
          bell_alerts_enabled: boolean
          city: string | null
          cnpj: string | null
          comm_timeout_minutes: number
          created_at: string
          device_limit: number
          email: string | null
          endereco: string | null
          id: string
          inema_enabled: boolean
          ip_restriction_enabled: boolean
          is_demo: boolean
          latitude: number | null
          latitude_sede: number | null
          license_key: string | null
          license_status: string
          longitude: number | null
          longitude_sede: number | null
          max_devices: number | null
          modules: Json
          name: string
          phone: string | null
          plan: string
          proprietario: string | null
          security_phase: number
          state: string | null
          state_code: string | null
          subscription_status: string
          switching_protection_seconds: number | null
          target_agent_version: string | null
          timezone: string
          trial_end_date: string | null
          trial_start_date: string | null
          updated_at: string
          zip_code: string | null
        }
        Insert: {
          agent_previous_version?: string | null
          automatic_start_batch_size?: number
          automatic_start_stagger_enabled?: boolean
          automatic_start_stagger_seconds?: number
          bell_alerts_enabled?: boolean
          city?: string | null
          cnpj?: string | null
          comm_timeout_minutes?: number
          created_at?: string
          device_limit?: number
          email?: string | null
          endereco?: string | null
          id?: string
          inema_enabled?: boolean
          ip_restriction_enabled?: boolean
          is_demo?: boolean
          latitude?: number | null
          latitude_sede?: number | null
          license_key?: string | null
          license_status?: string
          longitude?: number | null
          longitude_sede?: number | null
          max_devices?: number | null
          modules?: Json
          name: string
          phone?: string | null
          plan?: string
          proprietario?: string | null
          security_phase?: number
          state?: string | null
          state_code?: string | null
          subscription_status?: string
          switching_protection_seconds?: number | null
          target_agent_version?: string | null
          timezone?: string
          trial_end_date?: string | null
          trial_start_date?: string | null
          updated_at?: string
          zip_code?: string | null
        }
        Update: {
          agent_previous_version?: string | null
          automatic_start_batch_size?: number
          automatic_start_stagger_enabled?: boolean
          automatic_start_stagger_seconds?: number
          bell_alerts_enabled?: boolean
          city?: string | null
          cnpj?: string | null
          comm_timeout_minutes?: number
          created_at?: string
          device_limit?: number
          email?: string | null
          endereco?: string | null
          id?: string
          inema_enabled?: boolean
          ip_restriction_enabled?: boolean
          is_demo?: boolean
          latitude?: number | null
          latitude_sede?: number | null
          license_key?: string | null
          license_status?: string
          longitude?: number | null
          longitude_sede?: number | null
          max_devices?: number | null
          modules?: Json
          name?: string
          phone?: string | null
          plan?: string
          proprietario?: string | null
          security_phase?: number
          state?: string | null
          state_code?: string | null
          subscription_status?: string
          switching_protection_seconds?: number | null
          target_agent_version?: string | null
          timezone?: string
          trial_end_date?: string | null
          trial_start_date?: string | null
          updated_at?: string
          zip_code?: string | null
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
      inema_compliance_history: {
        Row: {
          alert_95_sent: boolean
          created_at: string
          equipment_id: string
          farm_id: string
          hours_used: number
          id: string
          max_daily_hours: number
          max_daily_volume_m3: number | null
          percent_used: number
          record_date: string
          updated_at: string
          volume_used_m3: number
        }
        Insert: {
          alert_95_sent?: boolean
          created_at?: string
          equipment_id: string
          farm_id: string
          hours_used?: number
          id?: string
          max_daily_hours: number
          max_daily_volume_m3?: number | null
          percent_used?: number
          record_date: string
          updated_at?: string
          volume_used_m3?: number
        }
        Update: {
          alert_95_sent?: boolean
          created_at?: string
          equipment_id?: string
          farm_id?: string
          hours_used?: number
          id?: string
          max_daily_hours?: number
          max_daily_volume_m3?: number | null
          percent_used?: number
          record_date?: string
          updated_at?: string
          volume_used_m3?: number
        }
        Relationships: [
          {
            foreignKeyName: "inema_compliance_history_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inema_compliance_history_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      inema_daily_compliance: {
        Row: {
          alerted: boolean
          day: string
          equipment_id: string
          equipment_name: string | null
          farm_id: string
          hours: number | null
          hours_limit: number | null
          hours_pct: number | null
          id: string
          peak_pct: number | null
          status: string | null
          updated_at: string
          volume_limit: number | null
          volume_m3: number | null
          volume_pct: number | null
          volume_source: string | null
        }
        Insert: {
          alerted?: boolean
          day: string
          equipment_id: string
          equipment_name?: string | null
          farm_id: string
          hours?: number | null
          hours_limit?: number | null
          hours_pct?: number | null
          id?: string
          peak_pct?: number | null
          status?: string | null
          updated_at?: string
          volume_limit?: number | null
          volume_m3?: number | null
          volume_pct?: number | null
          volume_source?: string | null
        }
        Update: {
          alerted?: boolean
          day?: string
          equipment_id?: string
          equipment_name?: string | null
          farm_id?: string
          hours?: number | null
          hours_limit?: number | null
          hours_pct?: number | null
          id?: string
          peak_pct?: number | null
          status?: string | null
          updated_at?: string
          volume_limit?: number | null
          volume_m3?: number | null
          volume_pct?: number | null
          volume_source?: string | null
        }
        Relationships: []
      }
      inema_permits: {
        Row: {
          created_at: string
          equipment_id: string
          expiration_date: string | null
          farm_id: string
          hydrographic_basin: string | null
          id: string
          latitude: number | null
          longitude: number | null
          max_daily_hours: number
          max_daily_volume_m3: number | null
          max_flow_m3h: number | null
          observacoes: string | null
          portaria_number: string | null
          process_number: string | null
          processo_number: string | null
          titular_name: string | null
          updated_at: string
          water_use_purpose: string | null
        }
        Insert: {
          created_at?: string
          equipment_id: string
          expiration_date?: string | null
          farm_id: string
          hydrographic_basin?: string | null
          id?: string
          latitude?: number | null
          longitude?: number | null
          max_daily_hours?: number
          max_daily_volume_m3?: number | null
          max_flow_m3h?: number | null
          observacoes?: string | null
          portaria_number?: string | null
          process_number?: string | null
          processo_number?: string | null
          titular_name?: string | null
          updated_at?: string
          water_use_purpose?: string | null
        }
        Update: {
          created_at?: string
          equipment_id?: string
          expiration_date?: string | null
          farm_id?: string
          hydrographic_basin?: string | null
          id?: string
          latitude?: number | null
          longitude?: number | null
          max_daily_hours?: number
          max_daily_volume_m3?: number | null
          max_flow_m3h?: number | null
          observacoes?: string | null
          portaria_number?: string | null
          process_number?: string | null
          processo_number?: string | null
          titular_name?: string | null
          updated_at?: string
          water_use_purpose?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inema_permits_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: true
            referencedRelation: "equipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inema_permits_farm_id_fkey"
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
      maintenance_orders: {
        Row: {
          completed_at: string | null
          completed_by: string | null
          completed_by_name: string | null
          created_at: string
          created_by: string | null
          created_by_name: string | null
          description: string | null
          equipment_id: string | null
          equipment_name: string | null
          farm_id: string
          id: string
          notes: string | null
          priority: string
          problem_type: string
          status: string
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          completed_by?: string | null
          completed_by_name?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          description?: string | null
          equipment_id?: string | null
          equipment_name?: string | null
          farm_id: string
          id?: string
          notes?: string | null
          priority?: string
          problem_type?: string
          status?: string
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          completed_by?: string | null
          completed_by_name?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          description?: string | null
          equipment_id?: string | null
          equipment_name?: string | null
          farm_id?: string
          id?: string
          notes?: string | null
          priority?: string
          problem_type?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_orders_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_orders_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
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
      phase_b_run_results: {
        Row: {
          executed_at: string
          id: number
          numbers: Json
          run_id: string | null
          step: string
        }
        Insert: {
          executed_at?: string
          id?: number
          numbers?: Json
          run_id?: string | null
          step: string
        }
        Update: {
          executed_at?: string
          id?: number
          numbers?: Json
          run_id?: string | null
          step?: string
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
          is_super_admin: boolean
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
          is_super_admin?: boolean
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
          is_super_admin?: boolean
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
      rate_limit_violations: {
        Row: {
          created_at: string
          details: Json
          endpoint: string
          hits: number
          id: string
          ip_address: string | null
          user_agent: string | null
          user_id: string | null
          violation_type: string
          window_seconds: number
        }
        Insert: {
          created_at?: string
          details?: Json
          endpoint: string
          hits?: number
          id?: string
          ip_address?: string | null
          user_agent?: string | null
          user_id?: string | null
          violation_type?: string
          window_seconds?: number
        }
        Update: {
          created_at?: string
          details?: Json
          endpoint?: string
          hits?: number
          id?: string
          ip_address?: string | null
          user_agent?: string | null
          user_id?: string | null
          violation_type?: string
          window_seconds?: number
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
      remote_reconciliation_queue: {
        Row: {
          applied_at: string | null
          applied_by: string | null
          applied_user: string | null
          batch_id: string
          candidates: Json
          created_at: string
          ended_at: string
          event_ids: string[]
          events_total: number
          events_unnamed: number
          farm_id: string
          id: string
          intent: string
          started_at: string
          status: string
          suggested_user: string | null
          suggestion_basis: Json
          suggestion_source: string | null
          suggestion_strength: string | null
        }
        Insert: {
          applied_at?: string | null
          applied_by?: string | null
          applied_user?: string | null
          batch_id: string
          candidates?: Json
          created_at?: string
          ended_at: string
          event_ids: string[]
          events_total: number
          events_unnamed: number
          farm_id: string
          id?: string
          intent: string
          started_at: string
          status?: string
          suggested_user?: string | null
          suggestion_basis?: Json
          suggestion_source?: string | null
          suggestion_strength?: string | null
        }
        Update: {
          applied_at?: string | null
          applied_by?: string | null
          applied_user?: string | null
          batch_id?: string
          candidates?: Json
          created_at?: string
          ended_at?: string
          event_ids?: string[]
          events_total?: number
          events_unnamed?: number
          farm_id?: string
          id?: string
          intent?: string
          started_at?: string
          status?: string
          suggested_user?: string | null
          suggestion_basis?: Json
          suggestion_source?: string | null
          suggestion_strength?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "remote_reconciliation_queue_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
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
      scheduled_automations: {
        Row: {
          action: string
          alert_after_retries: boolean
          created_at: string
          days_of_week: string[]
          excluded_equipment_ids: string[]
          farm_id: string
          id: string
          is_active: boolean
          last_run_at: string | null
          last_run_result: Json | null
          max_retries: number
          name: string
          retry_interval_min: number
          target_equipment_ids: string[]
          time_brt: string
          updated_at: string
        }
        Insert: {
          action?: string
          alert_after_retries?: boolean
          created_at?: string
          days_of_week?: string[]
          excluded_equipment_ids?: string[]
          farm_id: string
          id?: string
          is_active?: boolean
          last_run_at?: string | null
          last_run_result?: Json | null
          max_retries?: number
          name: string
          retry_interval_min?: number
          target_equipment_ids?: string[]
          time_brt: string
          updated_at?: string
        }
        Update: {
          action?: string
          alert_after_retries?: boolean
          created_at?: string
          days_of_week?: string[]
          excluded_equipment_ids?: string[]
          farm_id?: string
          id?: string
          is_active?: boolean
          last_run_at?: string | null
          last_run_result?: Json | null
          max_retries?: number
          name?: string
          retry_interval_min?: number
          target_equipment_ids?: string[]
          time_brt?: string
          updated_at?: string
        }
        Relationships: []
      }
      scheduled_shutdowns: {
        Row: {
          alert_sent: boolean
          alert1_sent: boolean
          alert2_sent: boolean
          attempt: number
          automation_id: string | null
          created_at: string
          farm_id: string
          id: string
          last_attempt_at: string | null
          remaining: Json | null
          run_date: string
          status: string
          steps_done: Json
          targeted: Json | null
          updated_at: string
        }
        Insert: {
          alert_sent?: boolean
          alert1_sent?: boolean
          alert2_sent?: boolean
          attempt?: number
          automation_id?: string | null
          created_at?: string
          farm_id: string
          id?: string
          last_attempt_at?: string | null
          remaining?: Json | null
          run_date: string
          status?: string
          steps_done?: Json
          targeted?: Json | null
          updated_at?: string
        }
        Update: {
          alert_sent?: boolean
          alert1_sent?: boolean
          alert2_sent?: boolean
          attempt?: number
          automation_id?: string | null
          created_at?: string
          farm_id?: string
          id?: string
          last_attempt_at?: string | null
          remaining?: Json | null
          run_date?: string
          status?: string
          steps_done?: Json
          targeted?: Json | null
          updated_at?: string
        }
        Relationships: []
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
          disk_free_mb: number | null
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
          disk_free_mb?: number | null
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
          disk_free_mb?: number | null
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
      switching_protection_audit: {
        Row: {
          changed_at: string
          changed_by: string
          enabled: boolean
          equipment_id: string
          farm_id: string | null
          id: number
          seconds: number | null
        }
        Insert: {
          changed_at?: string
          changed_by: string
          enabled: boolean
          equipment_id: string
          farm_id?: string | null
          id?: number
          seconds?: number | null
        }
        Update: {
          changed_at?: string
          changed_by?: string
          enabled?: boolean
          equipment_id?: string
          farm_id?: string | null
          id?: number
          seconds?: number | null
        }
        Relationships: []
      }
      system_alerts: {
        Row: {
          created_at: string
          details: Json | null
          id: number
          resolved: boolean
          resolved_at: string | null
          severity: string
          source: string | null
          title: string | null
        }
        Insert: {
          created_at?: string
          details?: Json | null
          id?: never
          resolved?: boolean
          resolved_at?: string | null
          severity: string
          source?: string | null
          title?: string | null
        }
        Update: {
          created_at?: string
          details?: Json | null
          id?: never
          resolved?: boolean
          resolved_at?: string | null
          severity?: string
          source?: string | null
          title?: string | null
        }
        Relationships: []
      }
      system_logs: {
        Row: {
          context: Json | null
          created_at: string
          farm_id: string | null
          id: string
          level: string
          message: string
          source: string | null
        }
        Insert: {
          context?: Json | null
          created_at?: string
          farm_id?: string | null
          id?: string
          level?: string
          message: string
          source?: string | null
        }
        Update: {
          context?: Json | null
          created_at?: string
          farm_id?: string | null
          id?: string
          level?: string
          message?: string
          source?: string | null
        }
        Relationships: []
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
      technical_display_prefs: {
        Row: {
          show_technical_times: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          show_technical_times?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          show_technical_times?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      technical_events: {
        Row: {
          agent_version: string | null
          attestation_source: Database["public"]["Enums"]["tech_attestation_source"]
          category: Database["public"]["Enums"]["tech_event_category"]
          client_event_id: string | null
          correlation_id: string | null
          created_at: string
          equipment_id: string | null
          event_type: string
          farm_id: string
          gateway_id: string | null
          id: string
          metadata: Json
          origin: Database["public"]["Enums"]["tech_event_origin"]
          payload: Json
          platform_version: string | null
          severity: Database["public"]["Enums"]["tech_event_severity"]
          source: string | null
        }
        Insert: {
          agent_version?: string | null
          attestation_source?: Database["public"]["Enums"]["tech_attestation_source"]
          category: Database["public"]["Enums"]["tech_event_category"]
          client_event_id?: string | null
          correlation_id?: string | null
          created_at?: string
          equipment_id?: string | null
          event_type: string
          farm_id: string
          gateway_id?: string | null
          id?: string
          metadata?: Json
          origin?: Database["public"]["Enums"]["tech_event_origin"]
          payload?: Json
          platform_version?: string | null
          severity?: Database["public"]["Enums"]["tech_event_severity"]
          source?: string | null
        }
        Update: {
          agent_version?: string | null
          attestation_source?: Database["public"]["Enums"]["tech_attestation_source"]
          category?: Database["public"]["Enums"]["tech_event_category"]
          client_event_id?: string | null
          correlation_id?: string | null
          created_at?: string
          equipment_id?: string | null
          event_type?: string
          farm_id?: string
          gateway_id?: string | null
          id?: string
          metadata?: Json
          origin?: Database["public"]["Enums"]["tech_event_origin"]
          payload?: Json
          platform_version?: string | null
          severity?: Database["public"]["Enums"]["tech_event_severity"]
          source?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "technical_events_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      user_activity_log: {
        Row: {
          action: string
          created_at: string
          farm_id: string | null
          id: string
          ip_address: string | null
          metadata: Json
          path: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          farm_id?: string | null
          id?: string
          ip_address?: string | null
          metadata?: Json
          path?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          farm_id?: string | null
          id?: string
          ip_address?: string | null
          metadata?: Json
          path?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
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
      water_permit_conditions: {
        Row: {
          condition_number: number | null
          created_at: string
          deadline_days: number | null
          description: string
          id: string
          is_critical: boolean | null
          permit_id: string
          status: string | null
        }
        Insert: {
          condition_number?: number | null
          created_at?: string
          deadline_days?: number | null
          description: string
          id?: string
          is_critical?: boolean | null
          permit_id: string
          status?: string | null
        }
        Update: {
          condition_number?: number | null
          created_at?: string
          deadline_days?: number | null
          description?: string
          id?: string
          is_critical?: boolean | null
          permit_id?: string
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "water_permit_conditions_permit_id_fkey"
            columns: ["permit_id"]
            isOneToOne: false
            referencedRelation: "water_permits"
            referencedColumns: ["id"]
          },
        ]
      }
      water_permit_wells: {
        Row: {
          created_at: string
          datum: string | null
          equipment_id: string | null
          flow_rate_m3_day: number
          id: string
          latitude: string | null
          longitude: string | null
          notes: string | null
          permit_id: string
          well_name: string
        }
        Insert: {
          created_at?: string
          datum?: string | null
          equipment_id?: string | null
          flow_rate_m3_day: number
          id?: string
          latitude?: string | null
          longitude?: string | null
          notes?: string | null
          permit_id: string
          well_name: string
        }
        Update: {
          created_at?: string
          datum?: string | null
          equipment_id?: string | null
          flow_rate_m3_day?: number
          id?: string
          latitude?: string | null
          longitude?: string | null
          notes?: string | null
          permit_id?: string
          well_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "water_permit_wells_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "water_permit_wells_permit_id_fkey"
            columns: ["permit_id"]
            isOneToOne: false
            referencedRelation: "water_permits"
            referencedColumns: ["id"]
          },
        ]
      }
      water_permits: {
        Row: {
          basin: string | null
          created_at: string
          farm_id: string
          holder_cpf_cnpj: string | null
          holder_name: string
          id: string
          irrigated_area_ha: number | null
          municipality: string | null
          notes: string | null
          permit_date: string
          permit_number: string
          process_number: string
          purpose: string | null
          regime_hours_per_day: number | null
          status: string | null
          updated_at: string
          validity_end: string
          validity_start: string
        }
        Insert: {
          basin?: string | null
          created_at?: string
          farm_id: string
          holder_cpf_cnpj?: string | null
          holder_name: string
          id?: string
          irrigated_area_ha?: number | null
          municipality?: string | null
          notes?: string | null
          permit_date: string
          permit_number: string
          process_number: string
          purpose?: string | null
          regime_hours_per_day?: number | null
          status?: string | null
          updated_at?: string
          validity_end: string
          validity_start: string
        }
        Update: {
          basin?: string | null
          created_at?: string
          farm_id?: string
          holder_cpf_cnpj?: string | null
          holder_name?: string
          id?: string
          irrigated_area_ha?: number | null
          municipality?: string | null
          notes?: string | null
          permit_date?: string
          permit_number?: string
          process_number?: string
          purpose?: string | null
          regime_hours_per_day?: number | null
          status?: string | null
          updated_at?: string
          validity_end?: string
          validity_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "water_permits_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
      }
      well_level_measurements: {
        Row: {
          created_at: string
          dynamic_level_m: number | null
          equipment_id: string | null
          farm_id: string
          id: string
          measured_at: string
          measured_by: string | null
          notes: string | null
          static_level_m: number | null
        }
        Insert: {
          created_at?: string
          dynamic_level_m?: number | null
          equipment_id?: string | null
          farm_id: string
          id?: string
          measured_at: string
          measured_by?: string | null
          notes?: string | null
          static_level_m?: number | null
        }
        Update: {
          created_at?: string
          dynamic_level_m?: number | null
          equipment_id?: string | null
          farm_id?: string
          id?: string
          measured_at?: string
          measured_by?: string | null
          notes?: string | null
          static_level_m?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "well_level_measurements_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "well_level_measurements_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
        ]
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
          alert_com_restaurada: boolean
          alert_ligar_desligar: boolean
          alert_local_change_enabled: boolean
          alert_offline_enabled: boolean
          alert_peak_hours_enabled: boolean
          alert_pico: boolean
          alert_recipients: string
          alert_sem_resposta: boolean
          alerts_enabled: boolean
          alerts_master_enabled: boolean
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
          alert_com_restaurada?: boolean
          alert_ligar_desligar?: boolean
          alert_local_change_enabled?: boolean
          alert_offline_enabled?: boolean
          alert_peak_hours_enabled?: boolean
          alert_pico?: boolean
          alert_recipients?: string
          alert_sem_resposta?: boolean
          alerts_enabled?: boolean
          alerts_master_enabled?: boolean
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
          alert_com_restaurada?: boolean
          alert_ligar_desligar?: boolean
          alert_local_change_enabled?: boolean
          alert_offline_enabled?: boolean
          alert_peak_hours_enabled?: boolean
          alert_pico?: boolean
          alert_recipients?: string
          alert_sem_resposta?: boolean
          alerts_enabled?: boolean
          alerts_master_enabled?: boolean
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
      whatsapp_health_log: {
        Row: {
          action_taken: string | null
          checked_at: string
          details: Json | null
          id: number
          last_incoming_at: string | null
          last_outgoing_at: string | null
          status: string
          subscription_ok: boolean | null
        }
        Insert: {
          action_taken?: string | null
          checked_at?: string
          details?: Json | null
          id?: never
          last_incoming_at?: string | null
          last_outgoing_at?: string | null
          status: string
          subscription_ok?: boolean | null
        }
        Update: {
          action_taken?: string | null
          checked_at?: string
          details?: Json | null
          id?: never
          last_incoming_at?: string | null
          last_outgoing_at?: string | null
          status?: string
          subscription_ok?: boolean | null
        }
        Relationships: []
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
      whatsapp_webhook_monitor_state: {
        Row: {
          down_strikes: number
          id: number
          last_healthy_at: string | null
          last_recovery_at: string | null
          phase: string
          probe_req_id: number | null
          probe_sent_at: string | null
          recovery_attempts: number
          updated_at: string
        }
        Insert: {
          down_strikes?: number
          id?: number
          last_healthy_at?: string | null
          last_recovery_at?: string | null
          phase?: string
          probe_req_id?: number | null
          probe_sent_at?: string | null
          recovery_attempts?: number
          updated_at?: string
        }
        Update: {
          down_strikes?: number
          id?: number
          last_healthy_at?: string | null
          last_recovery_at?: string | null
          phase?: string
          probe_req_id?: number | null
          probe_sent_at?: string | null
          recovery_attempts?: number
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      automation_row_classified: {
        Row: {
          action: Database["public"]["Enums"]["event_action"] | null
          actor_label: string | null
          created_at: string | null
          details: Json | null
          equipment_id: string | null
          equipment_name: string | null
          farm_id: string | null
          id: string | null
          issue: string | null
          occurred_at: string | null
          origin: Database["public"]["Enums"]["event_origin"] | null
          result: Database["public"]["Enums"]["event_result"] | null
          target_state: number | null
          user_email: string | null
          user_id: string | null
        }
        Insert: {
          action?: Database["public"]["Enums"]["event_action"] | null
          actor_label?: string | null
          created_at?: string | null
          details?: Json | null
          equipment_id?: string | null
          equipment_name?: string | null
          farm_id?: string | null
          id?: string | null
          issue?: never
          occurred_at?: string | null
          origin?: Database["public"]["Enums"]["event_origin"] | null
          result?: Database["public"]["Enums"]["event_result"] | null
          target_state?: never
          user_email?: string | null
          user_id?: string | null
        }
        Update: {
          action?: Database["public"]["Enums"]["event_action"] | null
          actor_label?: string | null
          created_at?: string | null
          details?: Json | null
          equipment_id?: string | null
          equipment_name?: string | null
          farm_id?: string | null
          id?: string | null
          issue?: never
          occurred_at?: string | null
          origin?: Database["public"]["Enums"]["event_origin"] | null
          result?: Database["public"]["Enums"]["event_result"] | null
          target_state?: never
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
      billing_customer_status: {
        Row: {
          customer_id: string | null
          customer_status:
            | Database["public"]["Enums"]["billing_customer_state"]
            | null
          doc_number: string | null
          due_soon: boolean | null
          is_delinquent: boolean | null
          legal_name: string | null
          max_days_overdue: number | null
          open_cents: number | null
          open_charges: number | null
          overdue_cents: number | null
        }
        Relationships: []
      }
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
      apply_remote_reconciliation:
        | {
            Args: {
              _evidence?: string
              _executor: string
              _expected_ids: string[]
              _queue_id: string
              _user_id: string
            }
            Returns: number
          }
        | {
            Args: {
              _confirm_corroborated?: boolean
              _evidence?: string
              _executor: string
              _expected_ids: string[]
              _queue_id: string
              _user_id: string
            }
            Returns: number
          }
      audit_automation_log_integrity: {
        Args: { _lookback?: string; _threshold?: number }
        Returns: number
      }
      authorship_source_catalog: {
        Args: never
        Returns: {
          coluna_farm: string
          coluna_identidade: string
          coluna_tempo: string
          tabela: string
          tipo: string
        }[]
      }
      automatic_desired_state: {
        Args: {
          _days: string[]
          _dow_prev: string
          _dow_today: string
          _mode: string
          _now_min: number
          _time_off: string
          _time_on: string
        }
        Returns: string
      }
      automatic_mode_actor_label: {
        Args: { _command_id: string }
        Returns: string
      }
      automation_attribution_rank: {
        Args: {
          _actor: string
          _origin: Database["public"]["Enums"]["event_origin"]
          _source_device: string
          _user_id: string
        }
        Returns: number
      }
      automation_global_acceptance: {
        Args: never
        Returns: {
          categoria: string
          fazendas_afetadas: string
          situacao: string
          violacoes: number
        }[]
      }
      automation_global_inventory: {
        Args: never
        Returns: {
          automacao_correta: number
          duplicidades: number
          fazenda: string
          local_comprovado: number
          origem_indefinida: number
          remoto_com_autor: number
          remoto_sem_autor: number
          sem_prova: number
          tecnicos_ruido: number
          total_oficial: number
          usuario_tecnico: number
        }[]
      }
      automation_issue_rows: {
        Args: { _categoria?: string }
        Returns: {
          acao: string
          ator: string
          categoria: string
          equipamento: string
          fazenda: string
          fonte_autoria: string
          id: string
          metodo_confirmacao: string
          ocorrido_brt: string
          origem: string
          tem_usuario: boolean
        }[]
      }
      automation_issue_summary: {
        Args: never
        Returns: {
          categoria: string
          descricao: string
          fazendas: number
          ocorrencias: number
        }[]
      }
      automation_report_acceptance: {
        Args: { _farm_id?: string }
        Returns: {
          criterio: string
          exemplos: string
          situacao: string
          violacoes: number
        }[]
      }
      automation_report_farm_audit: {
        Args: never
        Returns: {
          automacoes: number
          eventos_oficiais: number
          fazenda: string
          locais: number
          possiveis_duplicidades: number
          remotos_com_nome: number
          remotos_sem_nome: number
          tecnicos_ruido_excluido: number
          transicoes_sem_prova: number
        }[]
      }
      automation_row_issue: { Args: { _id: string }; Returns: string }
      automation_row_snapshot: { Args: { _id: string }; Returns: Json }
      backfill_automation_log_authorship: {
        Args: { _run_id?: string }
        Returns: string
      }
      billing_import_approve: { Args: { _job_id: string }; Returns: Json }
      billing_import_commit: { Args: { _job_id: string }; Returns: Json }
      billing_register_manual_payment: {
        Args: {
          _amount_cents: number
          _charge_id: string
          _method?: Database["public"]["Enums"]["billing_payment_method"]
          _notes?: string
          _paid_at?: string
        }
        Returns: Json
      }
      billing_reverse_payment: {
        Args: { _payment_id: string; _reason?: string }
        Returns: Json
      }
      build_actor_tag: {
        Args: { _name: string; _user_id: string }
        Returns: string
      }
      bump_automation_noise: {
        Args: { _equip: string; _farm: string; _reason: string }
        Returns: undefined
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
      can_admin_billing: { Args: { _user_id: string }; Returns: boolean }
      can_read_billing: { Args: { _user_id: string }; Returns: boolean }
      can_view_technical_telemetry: {
        Args: { _farm_id?: string; _user_id: string }
        Returns: boolean
      }
      can_write_billing: { Args: { _user_id: string }; Returns: boolean }
      can_write_farm: {
        Args: { _farm_id: string; _user_id: string }
        Returns: boolean
      }
      cancel_pending_pollings_for_plc: {
        Args: { _farm_id: string; _reason?: string; _tsnn: string }
        Returns: number
      }
      check_bridge_heartbeats: { Args: never; Returns: undefined }
      check_export_rate_limit: {
        Args: {
          _farm_id?: string
          _format?: string
          _report_type: string
          _row_count?: number
        }
        Returns: Json
      }
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
      check_switching_protection: {
        Args: {
          _equipment_id: string
          _requested_by?: string
          _source_device?: string
        }
        Returns: {
          allowed: boolean
          message: string
          seconds_remaining: number
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
      classify_actuation_origin: {
        Args: {
          _at?: string
          _equipment_id: string
          _farm_id: string
          _turning_on: boolean
        }
        Returns: {
          evidence: string
          forced: boolean
          origin: string
          rule_name: string
        }[]
      }
      classify_command_origin_kind: {
        Args: { _created_by: string; _source_device: string }
        Returns: string
      }
      classify_physical_transition: {
        Args: {
          _at?: string
          _equipment_id: string
          _farm_id: string
          _turning_on: boolean
          _window?: string
        }
        Returns: {
          actor_label: string
          authorship_source: string
          command_id: string
          origin: Database["public"]["Enums"]["event_origin"]
          user_email: string
          user_id: string
        }[]
      }
      cleanup_api_hits: { Args: never; Returns: undefined }
      cleanup_automation_log_farm: {
        Args: { _batch_order?: number; _farm_id: string; _run_id: string }
        Returns: number
      }
      cleanup_duplicate_transitions: {
        Args: { _farm_id?: string; _run_id: string }
        Returns: number
      }
      cleanup_stale_data: { Args: never; Returns: Json }
      cleanup_technical_events: {
        Args: { _farm_id?: string; _run_id: string }
        Returns: number
      }
      cleanup_unconfirmed_commands: {
        Args: { _farm_id?: string; _run_id: string }
        Returns: number
      }
      clear_agent_update: { Args: { _farm_id: string }; Returns: undefined }
      close_orphan_offline_cycles: { Args: never; Returns: number }
      close_orphan_pump_runtime: {
        Args: { _max_idle_minutes?: number }
        Returns: number
      }
      comm_incident_detail: {
        Args: { _notification_id: string }
        Returns: {
          camada: string
          detalhe: string
          quando: string
        }[]
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
      confirm_authorship_batch: {
        Args: {
          _admin_id: string
          _batch_id: string
          _expected_count: number
          _user_id: string
        }
        Returns: {
          restaurados: number
          run_id: string
        }[]
      }
      count_automatic_start_slots_in_use: {
        Args: { _farm_id: string; _settle_seconds?: number }
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
      cron_invoke: { Args: { _body?: Json; _fn: string }; Returns: number }
      cron_secret: { Args: never; Returns: string }
      cron_secret_configured: { Args: never; Returns: boolean }
      current_operator_phone: { Args: { _uid: string }; Returns: string }
      dashboard_equipment_operational: {
        Args: { _farm_id: string }
        Returns: {
          actuation_origin: string
          desired_running: boolean
          id: string
          is_offline: boolean
          is_unstable: boolean
          maintenance_mode: boolean
          name: string
          read_token: string
          running: boolean
          switching_locked: boolean
        }[]
      }
      deactivate_stale_devices: { Args: never; Returns: undefined }
      debug_alert_system: { Args: never; Returns: Json }
      detect_security_anomalies: { Args: never; Returns: Json }
      dms_to_decimal: { Args: { p_dms: string }; Returns: number }
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
      enqueue_remote_reconciliation: {
        Args: { _farm_id?: string }
        Returns: number
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
      false_power_alerts: {
        Args: { _hours?: number }
        Returns: {
          bombas_na_janela: number
          created_at: string
          farm_id: string
          fazenda: string
          id: string
          tem_prova: boolean
        }[]
      }
      false_power_alerts_summary: {
        Args: { _hours?: number }
        Returns: {
          com_prova: number
          outros_alertas_intocados: number
          sem_prova: number
          total: number
        }[]
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
      farm_device_status: {
        Args: { _farm_id: string }
        Returns: {
          activated_at: string
          agent_version: string
          device_id: string
          last_seen_at: string
          revoked: boolean
        }[]
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
      finalize_origin_and_authorship: {
        Args: { _farm_id?: string; _run_id: string }
        Returns: {
          corrigidos: number
          enfileirados: number
        }[]
      }
      fix_contaminated_local_origin: {
        Args: { _hours?: number }
        Returns: {
          de: string
          equipamento: string
          equipment_id: string
          evidencia: string
          forcado: boolean
          para: string
          regra: string
        }[]
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
      get_technical_display_pref: {
        Args: { _actor?: string }
        Returns: boolean
      }
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
      haversine_m: {
        Args: { lat1: number; lat2: number; lon1: number; lon2: number }
        Returns: number
      }
      hidden_physical_transitions: {
        Args: { _hours?: number }
        Returns: {
          com_command_audit: number
          fazenda: string
          linhas: number
          motivo: string
          origem: string
          sem_prova: number
        }[]
      }
      historical_remote_batches: {
        Args: { _farm_id?: string; _from?: string; _gap?: string; _to?: string }
        Returns: {
          acao: string
          batch_id: string
          contaminado: boolean
          decisao_proposta: string
          farm_id: string
          farm_name: string
          fim_brt: string
          fontes_autoria: string
          inicio_brt: string
          ja_atribuidos: number
          motivo: string
          pocos: string
          sem_autor: number
          total_eventos: number
          usuario_unico: string
          usuario_unico_nome: string
          usuarios_fortes: number
        }[]
      }
      increment_fingerprint_mismatch: {
        Args: { _device_id: string }
        Returns: undefined
      }
      inema_farm_score:
        | {
            Args: { _days?: number; _farm_id: string }
            Returns: {
              dias_excedido: number
              dias_ok: number
              score_pct: number
              total_dias: number
            }[]
          }
        | {
            Args: { p_date?: string; p_farm_id: string }
            Returns: {
              alerts_pending: number
              avg_pct_hours: number
              avg_pct_volume: number
              total_permits: number
            }[]
          }
      inema_mark_alerted: {
        Args: { _day?: string; _equipment_id: string }
        Returns: undefined
      }
      inema_snapshot: {
        Args: { _farm_id: string }
        Returns: {
          equipment_id: string
          equipment_name: string
          farm_id: string
          hours: number
          hours_limit: number
          peak_pct: number
          volume_limit: number
          volume_m3: number
        }[]
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
      is_strong_authorship_source: { Args: { _src: string }; Returns: boolean }
      is_technical_actor_label: { Args: { _label: string }; Returns: boolean }
      is_whatsapp_approve_admin: { Args: { _uid: string }; Returns: boolean }
      is_whatsapp_register_admin: { Args: { _uid: string }; Returns: boolean }
      is_whatsapp_super_admin: { Args: { _uid: string }; Returns: boolean }
      is_workday: { Args: { d: string }; Returns: boolean }
      last_changed_by_format_report: {
        Args: never
        Returns: {
          com_user_uuid: number
          farm_id: string
          farm_name: string
          nulo_ou_vazio: number
          somente_nome: number
          total: number
          uuid_valido_em_profiles: number
        }[]
      }
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
      log_user_activity: {
        Args: {
          _action: string
          _farm_id?: string
          _metadata?: Json
          _path?: string
        }
        Returns: string
      }
      mark_agent_commands_expired: {
        Args: { _farm_id: string }
        Returns: number
      }
      mark_automation_command_failures: { Args: never; Returns: number }
      mark_automation_noise: {
        Args: {
          _category: string
          _evidence?: Json
          _executed_by?: string
          _ids: string[]
          _reason: string
          _run_id: string
        }
        Returns: number
      }
      mark_commands_timeout: { Args: { _farm_id: string }; Returns: number }
      mark_corroborated_candidates: {
        Args: { _run_id: string }
        Returns: number
      }
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
      master_manages_farm: {
        Args: { _farm_id: string; _uid: string }
        Returns: boolean
      }
      parse_user_uuid: { Args: { _text: string }; Returns: string }
      phase_b_acceptance: {
        Args: never
        Returns: {
          criterio: string
          fazendas: string
          situacao: string
          violacoes: number
        }[]
      }
      phase_b_impact_report: {
        Args: { _run_id?: string }
        Returns: {
          enviados_fila: number
          fazenda: string
          pendencias_admin: number
          reclassificados: number
          ruido_tecnico: number
          total_antes: number
          total_final: number
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
      purge_agent_technical_events: {
        Args: { _keep?: string }
        Returns: number
      }
      purge_false_power_alerts: {
        Args: { _hours?: number }
        Returns: {
          outros_intocados: number
          preservados: number
          removidos: number
        }[]
      }
      purge_stale_on_commands_when_bridge_down: {
        Args: never
        Returns: {
          cancelled_count: number
          farm_id: string
        }[]
      }
      record_agent_technical_event: {
        Args: {
          _agent_jti: string
          _agent_version?: string
          _category: Database["public"]["Enums"]["tech_event_category"]
          _client_event_id?: string
          _correlation_id?: string
          _equipment_id?: string
          _event_type: string
          _gateway_id?: string
          _metadata?: Json
          _occurred_at?: string
          _origin?: Database["public"]["Enums"]["tech_event_origin"]
          _payload?: Json
          _severity?: Database["public"]["Enums"]["tech_event_severity"]
        }
        Returns: string
      }
      record_technical_event: {
        Args: {
          _agent_version?: string
          _category: Database["public"]["Enums"]["tech_event_category"]
          _client_event_id?: string
          _correlation_id?: string
          _equipment_id?: string
          _event_type: string
          _farm_id: string
          _gateway_id?: string
          _metadata?: Json
          _occurred_at?: string
          _origin?: Database["public"]["Enums"]["tech_event_origin"]
          _payload?: Json
          _platform_version?: string
          _severity?: Database["public"]["Enums"]["tech_event_severity"]
          _source?: string
        }
        Returns: string
      }
      recover_hidden_transitions: {
        Args: { _farm_id?: string; _hours?: number }
        Returns: {
          automacao: number
          local_real: number
          mantidos_privados: number
          recuperados: number
          remoto: number
          run_id: string
          whatsapp: number
        }[]
      }
      remote_authorship_decision: {
        Args: { _farm_id?: string; _gap?: string }
        Returns: {
          acao: string
          acao_proposta: string
          batch_id: string
          candidata_user_id: string
          candidatas: number
          conflito: boolean
          eventos: number
          evidencias: string
          fazenda: string
          fim_brt: string
          ids: string[]
          inicio_brt: string
          pessoa_candidata: string
          sem_nome: number
        }[]
      }
      remote_event_authorship_candidates: {
        Args: { _log_id: string; _window?: string }
        Returns: {
          email: string
          evidencia: string
          fonte: string
          forca: string
          nome: string
          user_id: string
        }[]
      }
      remote_without_person: {
        Args: { _hours?: number }
        Returns: {
          acao: string
          equipamento: string
          evento_id: string
          evidencia: string
          fazenda: string
          ocorrido: string
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
      report_origin_breakdown: {
        Args: { _hours?: number }
        Returns: {
          escondido: number
          fazenda: string
          oficial: number
          origem: string
        }[]
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
      resolve_event_authorship: {
        Args: { _log_id: string }
        Returns: {
          actor_label: string
          confidence: string
          evidence: Json
          evidence_source: string
          origin_final: string
          user_email: string
          user_id: string
        }[]
      }
      resolve_user_display_name: { Args: { _uid: string }; Returns: string }
      restore_purged_power_alerts: { Args: never; Returns: number }
      rollback_cleanup_run: { Args: { _run_id: string }; Returns: number }
      rollback_recovery_run: { Args: { _run_id: string }; Returns: number }
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
      run_phase_b_cleanup: {
        Args: { _farm_id?: string }
        Returns: {
          duplicidades: number
          nao_confirmados: number
          run_id: string
          tecnicos: number
        }[]
      }
      send_security_alert_whatsapp: {
        Args: { _alert_id: string }
        Returns: undefined
      }
      set_switching_protection: {
        Args: {
          _actor?: string
          _enabled: boolean
          _equipment_id: string
          _seconds?: number
        }
        Returns: {
          enabled: boolean
          equipment_id: string
          seconds: number
        }[]
      }
      set_technical_display_pref: {
        Args: { _actor?: string; _show: boolean }
        Returns: boolean
      }
      sweep_stuck_pump_commands: { Args: never; Returns: number }
      switching_protection_list: {
        Args: { _farm_id: string }
        Returns: {
          currently_locked: boolean
          enabled: boolean
          equipment_id: string
          equipment_name: string
          last_change_at: string
          last_change_by: string
          seconds: number
        }[]
      }
      switching_protection_status: {
        Args: { _equipment_id: string }
        Returns: {
          last_confirmed_at: string
          last_state: boolean
          locked: boolean
          seconds_remaining: number
        }[]
      }
      touch_active_session: { Args: { _session_id: string }; Returns: boolean }
      update_flow_from_telemetry: {
        Args: { _farm_id: string; _raw: string; _tsnn: string }
        Returns: undefined
      }
      wa_send_message: {
        Args: { p_body: string; p_to: string }
        Returns: undefined
      }
      wa_webhook_monitor: { Args: never; Returns: undefined }
      wa_webhook_resubscribe: { Args: never; Returns: undefined }
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
        | "serial_terminal"
        | "serial_sniff"
        | "unblock_agent"
        | "reboot_agent"
        | "update_bridge"
        | "set_backend"
        | "rollback_backend"
      agent_cmd_status:
        | "pending"
        | "ack"
        | "executing"
        | "done"
        | "error"
        | "expired"
      app_role: "owner" | "admin" | "operator" | "viewer" | "supervisor"
      billing_actor_kind: "manual" | "automatic" | "webhook" | "import"
      billing_adjustment_index: "nenhum" | "ipca" | "igpm" | "inpc"
      billing_charge_status:
        | "prevista"
        | "aberta"
        | "enviada"
        | "paga"
        | "paga_parcial"
        | "vencida"
        | "em_negociacao"
        | "cancelada"
        | "estornada"
      billing_contract_status:
        | "rascunho"
        | "ativo"
        | "pausado"
        | "encerrado"
        | "cancelado"
      billing_customer_state: "ativo" | "inativo" | "prospect"
      billing_doc_type: "cnpj" | "cpf"
      billing_import_kind: "carteira" | "clientes" | "contratos" | "cobrancas"
      billing_import_row_status:
        | "valida"
        | "invalida"
        | "duplicada"
        | "ignorada"
        | "aplicada"
      billing_import_status:
        | "criado"
        | "lido"
        | "mapeado"
        | "validado"
        | "aprovado"
        | "aplicado"
        | "descartado"
        | "erro"
      billing_method_status:
        | "pendente"
        | "ativo"
        | "revogado"
        | "expirado"
        | "falhou"
      billing_payment_kind: "pagamento" | "estorno" | "reembolso" | "ajuste"
      billing_payment_method:
        | "pix"
        | "pix_automatico"
        | "boleto"
        | "transferencia"
        | "cartao"
        | "outro"
        | "cartao_credito"
        | "cartao_debito"
        | "apple_pay"
        | "google_pay"
      billing_payment_origin:
        | "manual"
        | "gateway"
        | "webhook"
        | "conciliacao"
        | "importacao"
      billing_payment_status:
        | "pendente"
        | "autorizado"
        | "capturado"
        | "parcial"
        | "quitado"
        | "cancelado"
        | "estornado"
        | "falhou"
        | "expirado"
      billing_periodicity:
        | "mensal"
        | "bimestral"
        | "trimestral"
        | "semestral"
        | "anual"
      billing_role: "finance" | "finance_viewer"
      billing_type:
        | "taxa_acesso_online"
        | "mensalidade_plataforma"
        | "manutencao"
        | "servico"
        | "personalizado"
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
      event_origin:
        | "remote"
        | "local"
        | "auto"
        | "reading"
        | "system"
        | "whatsapp"
      event_result: "success" | "fail" | "pending" | "timeout"
      tampering_kind:
        | "asar_modified"
        | "hardware_changed"
        | "config_replaced"
        | "integrity_check_failed"
        | "unsigned_binary"
        | "other"
      tampering_level: "info" | "warn" | "critical"
      tech_attestation_source:
        | "agent"
        | "cloud"
        | "system"
        | "manual"
        | "imported"
      tech_event_category:
        | "internet"
        | "heartbeat"
        | "cloud"
        | "bridge"
        | "serial"
        | "radio"
        | "plc"
        | "polling"
        | "automation"
        | "command"
        | "scheduler"
        | "watchdog"
        | "communication"
        | "power"
        | "startup"
        | "shutdown"
        | "system"
      tech_event_origin:
        | "cloud"
        | "agent"
        | "plc"
        | "radio"
        | "scheduler"
        | "automation"
        | "manual"
        | "local"
        | "unknown"
      tech_event_severity: "info" | "warning" | "error" | "critical"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
        "serial_terminal",
        "serial_sniff",
        "unblock_agent",
        "reboot_agent",
        "update_bridge",
        "set_backend",
        "rollback_backend",
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
      billing_actor_kind: ["manual", "automatic", "webhook", "import"],
      billing_adjustment_index: ["nenhum", "ipca", "igpm", "inpc"],
      billing_charge_status: [
        "prevista",
        "aberta",
        "enviada",
        "paga",
        "paga_parcial",
        "vencida",
        "em_negociacao",
        "cancelada",
        "estornada",
      ],
      billing_contract_status: [
        "rascunho",
        "ativo",
        "pausado",
        "encerrado",
        "cancelado",
      ],
      billing_customer_state: ["ativo", "inativo", "prospect"],
      billing_doc_type: ["cnpj", "cpf"],
      billing_import_kind: ["carteira", "clientes", "contratos", "cobrancas"],
      billing_import_row_status: [
        "valida",
        "invalida",
        "duplicada",
        "ignorada",
        "aplicada",
      ],
      billing_import_status: [
        "criado",
        "lido",
        "mapeado",
        "validado",
        "aprovado",
        "aplicado",
        "descartado",
        "erro",
      ],
      billing_method_status: [
        "pendente",
        "ativo",
        "revogado",
        "expirado",
        "falhou",
      ],
      billing_payment_kind: ["pagamento", "estorno", "reembolso", "ajuste"],
      billing_payment_method: [
        "pix",
        "pix_automatico",
        "boleto",
        "transferencia",
        "cartao",
        "outro",
        "cartao_credito",
        "cartao_debito",
        "apple_pay",
        "google_pay",
      ],
      billing_payment_origin: [
        "manual",
        "gateway",
        "webhook",
        "conciliacao",
        "importacao",
      ],
      billing_payment_status: [
        "pendente",
        "autorizado",
        "capturado",
        "parcial",
        "quitado",
        "cancelado",
        "estornado",
        "falhou",
        "expirado",
      ],
      billing_periodicity: [
        "mensal",
        "bimestral",
        "trimestral",
        "semestral",
        "anual",
      ],
      billing_role: ["finance", "finance_viewer"],
      billing_type: [
        "taxa_acesso_online",
        "mensalidade_plataforma",
        "manutencao",
        "servico",
        "personalizado",
      ],
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
      event_origin: [
        "remote",
        "local",
        "auto",
        "reading",
        "system",
        "whatsapp",
      ],
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
      tech_attestation_source: [
        "agent",
        "cloud",
        "system",
        "manual",
        "imported",
      ],
      tech_event_category: [
        "internet",
        "heartbeat",
        "cloud",
        "bridge",
        "serial",
        "radio",
        "plc",
        "polling",
        "automation",
        "command",
        "scheduler",
        "watchdog",
        "communication",
        "power",
        "startup",
        "shutdown",
        "system",
      ],
      tech_event_origin: [
        "cloud",
        "agent",
        "plc",
        "radio",
        "scheduler",
        "automation",
        "manual",
        "local",
        "unknown",
      ],
      tech_event_severity: ["info", "warning", "error", "critical"],
    },
  },
} as const
