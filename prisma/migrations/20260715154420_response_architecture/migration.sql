-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "isNearby" TEXT NOT NULL DEFAULT 'SOMETIMES';

-- AlterTable
ALTER TABLE "SosContact" ADD COLUMN     "isNearby" TEXT NOT NULL DEFAULT 'SOMETIMES';

-- CreateTable
CREATE TABLE "SosResponse" (
    "id" TEXT NOT NULL,
    "sosEventId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "respondedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SosResponse_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "SosResponse" ADD CONSTRAINT "SosResponse_sosEventId_fkey" FOREIGN KEY ("sosEventId") REFERENCES "SosEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
