-- AlterTable
ALTER TABLE "agent_inbox_items" DROP COLUMN "bodySha256",
DROP COLUMN "editedBeforeSend",
DROP COLUMN "factualCorrection",
DROP COLUMN "sentBodySha256";

