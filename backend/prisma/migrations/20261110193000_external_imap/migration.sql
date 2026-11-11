-- CreateTable
CREATE TABLE "external_imap_accounts" (
    "mailboxId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 993,
    "username" TEXT NOT NULL,
    "encryptedPassword" TEXT NOT NULL,

    CONSTRAINT "external_imap_accounts_pkey" PRIMARY KEY ("mailboxId")
);

-- AddForeignKey
ALTER TABLE "external_imap_accounts" ADD CONSTRAINT "external_imap_accounts_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "mailbox_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

