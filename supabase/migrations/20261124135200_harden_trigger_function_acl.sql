-- Harden the trigger-only recovery audit function boundary.
-- The function is SECURITY DEFINER because it is invoked by a task-row trigger,
-- but it is not a public RPC and must not be callable by API roles.
REVOKE ALL ON FUNCTION public.audit_task_socket_recovery_event()
  FROM PUBLIC, anon, authenticated;

-- Keep trigger execution available to the database owner while denying
-- direct execution through the exposed public schema/API roles.
GRANT EXECUTE ON FUNCTION public.audit_task_socket_recovery_event()
  TO postgres;
