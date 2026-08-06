-- Add nullable avatar URL from the Keycloak `picture` claim (suite avatar spine).
ALTER TABLE "users" ADD COLUMN "picture" TEXT;
