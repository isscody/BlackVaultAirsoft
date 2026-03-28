import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { revalidateDashboardData } from "@/lib/dashboard/revalidate-dashboard";
import { decryptField } from "@/lib/crypto";


function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function fallbackSerialNumber() {
  return `AUTO-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

// GET /api/firearms - Lista tutte le repliche ASG con conteggio loadout
export async function GET() {
  try {
    const firearms = await prisma.firearm.findMany({
      include: {
        _count: {
          select: { builds: true },
        },
        builds: {
          where: { isActive: true },
          take: 1,
          include: {
            slots: {
              include: {
                accessory: true,
              },
            },
          },
        },
        rangeSessions: {
          select: { roundsFired: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const result = firearms.map((firearm) => ({
      ...firearm,
      // firearmRoundCount: totale BBS sparate con questa replica
      firearmRoundCount: firearm.rangeSessions.reduce((sum, session) => sum + session.roundsFired, 0),
      serialNumber: decryptField(firearm.serialNumber) ?? firearm.serialNumber,
      notes: firearm.notes,
      buildCount: firearm._count.builds,
      activeBuild: firearm.builds[0] ?? null,
      builds: undefined,
      rangeSessions: undefined,
      _count: undefined,
    }));

    return NextResponse.json(result);
  } catch (error) {
    console.error("GET /api/firearms error:", error);
    return NextResponse.json(
      { error: "Errore nel recupero delle repliche" },
      { status: 500 }
    );
  }
}

// POST /api/firearms - Crea una nuova replica ASG
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const {
      name,
      manufacturer,
      model,
      caliber,            // grammatura BBS consigliata, es. "0.25g"
      compatibleCalibers, // grammature compatibili, es. "0.20g,0.25g,0.28g"
      serialNumber,
      type,               // AEG | AEP | GBB_PISTOLA | GBB_FUCILE | HPA | NGRS | GAS_NBB | SPRINGER | DMR_SNIPER
      acquisitionDate,
      purchasePrice,
      currentValue,
      notes,
      imageUrl,
      imageSource,
      lastMaintenanceDate,
      maintenanceIntervalDays,
      initialRoundCount,  // BBS pre-esistenti (uso precedente all'inserimento)
    } = body;

    const normalizedName = normalizeString(name);
    if (!normalizedName) {
      return NextResponse.json(
        { error: "Campo obbligatorio mancante: nome" },
        { status: 400 }
      );
    }

    const firearm = await prisma.firearm.create({
      data: {
        name: normalizedName,
        manufacturer: normalizeString(manufacturer) || "Sconosciuto",
        model: normalizeString(model) || "Sconosciuto",
        caliber: normalizeString(caliber) || "0.20g",
        compatibleCalibers: compatibleCalibers
          ? compatibleCalibers.split(",").map((s: string) => s.trim()).filter(Boolean).join(",") || null
          : null,
        serialNumber: normalizeString(serialNumber) || fallbackSerialNumber(),
        type: normalizeString(type) || "AEG",
        acquisitionDate: acquisitionDate ? new Date(acquisitionDate) : new Date(),
        purchasePrice: purchasePrice ?? null,
        currentValue: currentValue ?? null,
        notes: notes ? normalizeString(notes) : null,
        imageUrl: imageUrl ?? null,
        imageSource: imageSource ?? null,
        lastMaintenanceDate: lastMaintenanceDate ? new Date(lastMaintenanceDate) : null,
        maintenanceIntervalDays: maintenanceIntervalDays ?? null,
      },
      include: {
        _count: {
          select: { builds: true },
        },
        rangeSessions: {
          select: { roundsFired: true },
        },
      },
    });

    // Se l'utente specifica BBS pre-esistenti, le registra come sessione iniziale
    const parsedInitialRounds = initialRoundCount ? Math.floor(Number(initialRoundCount)) : 0;
    if (parsedInitialRounds > 0) {
      await prisma.rangeSession.create({
        data: {
          firearmId: firearm.id,
          sessionDate: firearm.acquisitionDate ?? new Date(),
          location: "Uso precedente",
          roundsFired: parsedInitialRounds,
          notes: "BBS iniziali registrate al momento dell'inserimento in archivio.",
        },
      });
    }

    revalidateDashboardData();

    return NextResponse.json(
      { ...firearm, buildCount: firearm._count.builds, _count: undefined },
      { status: 201 }
    );
  } catch (error: unknown) {
    console.error("POST /api/firearms error:", error);
    if (
      error instanceof Error &&
      error.message.includes("Unique constraint failed") &&
      error.message.includes("serialNumber")
    ) {
      return NextResponse.json(
        { error: "Esiste già una replica con questo numero seriale" },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "Errore nella creazione della replica" },
      { status: 500 }
    );
  }
}
