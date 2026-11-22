# Profile photo storage

MicoPesa stores profile photos as private files outside the web-served frontend
directory. The `users.profile_photo_ref` column contains only a server-generated
file reference; photo reads and writes require authentication and are scoped to
the current user's database identity.

For local development, files default to `apps/api/storage/profile-photos`.
Production deployments must set `PROFILE_PHOTO_STORAGE_DIR` to a persistent,
private volume mounted for the API service. The API intentionally refuses photo
uploads in production when this setting is absent. All API instances that serve
the same users must share the same durable storage volume, or use a future
private object-storage adapter with the same authenticated access contract.

Back up this directory together with the database. Database backups alone do
not include the photo contents. Never expose the storage directory through
static-file middleware.

Email verification and recovery workflows are implemented. An address must
complete the verification flow before it can be used for sign-in or recovery;
provider configuration and delivery must be verified separately in the target
deployment. See [Authentication email and account recovery](./auth-email-recovery.md).
