-- Keep the existing SSO photo while giving the field the API/domain name used
-- by the signed-in user's profile response.
ALTER TABLE "users" RENAME COLUMN "picture" TO "avatarUrl";
