-- AlterTable
ALTER TABLE "agent_inbox_items" ADD COLUMN     "bodySha256" TEXT,
ADD COLUMN     "editedBeforeSend" BOOLEAN,
ADD COLUMN     "factualCorrection" BOOLEAN,
ADD COLUMN     "sentBodySha256" TEXT;

