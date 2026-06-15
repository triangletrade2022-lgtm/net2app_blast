import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { clients, suppliers, smsLogs } from "@/db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { handleApiError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  try {
    const entityType = req.nextUrl.searchParams.get("type") || "client";
    const entityId = req.nextUrl.searchParams.get("id");

    if (entityId) {
      if (entityType === "client") {
        const [client] = await db.select().from(clients).where(eq(clients.id, parseInt(entityId))).limit(1);
        if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });
        const [stats] = await db.select({
          totalMessages: sql<number>`COALESCE(count(*), 0)::int`,
          totalSpent: sql<string>`COALESCE(sum(cast(${smsLogs.pay} as numeric)), '0')::text`,
          totalDelivered: sql<number>`COALESCE(sum(${smsLogs.deliverSuccess}), 0)::int`,
          totalFailed: sql<number>`COALESCE(sum(${smsLogs.submitFail}), 0)::int`,
        }).from(smsLogs).where(eq(smsLogs.clientId, client.id));
        return NextResponse.json({ entity: client, entityType: "client", stats });
      } else {
        const [supplier] = await db.select().from(suppliers).where(eq(suppliers.id, parseInt(entityId))).limit(1);
        if (!supplier) return NextResponse.json({ error: "Not found" }, { status: 404 });
        const [stats] = await db.select({
          totalMessages: sql<number>`COALESCE(count(*), 0)::int`,
          totalCost: sql<string>`COALESCE(sum(cast(${smsLogs.cost} as numeric)), '0')::text`,
          totalDelivered: sql<number>`COALESCE(sum(${smsLogs.deliverSuccess}), 0)::int`,
        }).from(smsLogs).where(eq(smsLogs.supplierId, supplier.id));
        return NextResponse.json({ entity: supplier, entityType: "supplier", stats });
      }
    }

    // List all with balances
    if (entityType === "client") {
      const allClients = await db.select().from(clients).orderBy(desc(clients.createdAt));
      const enriched = [];
      for (const c of allClients) {
        const [stats] = await db.select({
          totalMessages: sql<number>`COALESCE(count(*), 0)::int`,
          totalSpent: sql<string>`COALESCE(sum(cast(${smsLogs.pay} as numeric)), '0')::text`,
        }).from(smsLogs).where(eq(smsLogs.clientId, c.id));
        enriched.push({ ...c, totalMessages: stats.totalMessages, totalSpent: stats.totalSpent });
      }
      return NextResponse.json(enriched);
    }

    const allSuppliers = await db.select().from(suppliers).orderBy(desc(suppliers.createdAt));
    const enriched = [];
    for (const s of allSuppliers) {
      const [stats] = await db.select({
        totalMessages: sql<number>`COALESCE(count(*), 0)::int`,
        totalCost: sql<string>`COALESCE(sum(cast(${smsLogs.cost} as numeric)), '0')::text`,
      }).from(smsLogs).where(eq(smsLogs.supplierId, s.id));
      enriched.push({ ...s, totalMessages: stats.totalMessages, totalCost: stats.totalCost });
    }
    return NextResponse.json(enriched);
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { type, id, amount, operation } = body;
    const entityId = parseInt(id);
    const amt = parseFloat(amount);

    if (isNaN(amt) || amt < 0) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }

    if (type === "client") {
      const [client] = await db.select().from(clients).where(eq(clients.id, entityId)).limit(1);
      if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

      const currentBalance = parseFloat(client.currentBalance || "0");
      const currentCredit = parseFloat(client.creditLimit || "0");
      let newBalance = currentBalance;
      let newCredit = currentCredit;

      if (operation === "add_balance") {
        newBalance = currentBalance + amt;
      } else if (operation === "add_credit") {
        newCredit = currentCredit + amt;
      } else if (operation === "deduct_balance") {
        newBalance = Math.max(0, currentBalance - amt);
      } else if (operation === "deduct_credit") {
        newCredit = Math.max(0, currentCredit - amt);
      } else if (operation === "set_balance") {
        newBalance = amt;
      } else if (operation === "set_credit") {
        newCredit = amt;
      } else {
        // default: add to balance
        newBalance = currentBalance + amt;
      }

      const [updated] = await db.update(clients).set({
        currentBalance: String(newBalance),
        creditLimit: String(newCredit),
        updatedAt: new Date(),
      }).where(eq(clients.id, entityId)).returning();

      return NextResponse.json({
        success: true,
        previousBalance: String(currentBalance),
        previousCredit: String(currentCredit),
        newBalance: String(newBalance),
        newCredit: String(newCredit),
        totalAvailable: newBalance + newCredit,
        operation,
      });
    } else if (type === "supplier") {
      const [supplier] = await db.select().from(suppliers).where(eq(suppliers.id, entityId)).limit(1);
      if (!supplier) return NextResponse.json({ error: "Supplier not found" }, { status: 404 });

      const currentBalance = parseFloat(supplier.currentBalance || "0");
      const currentCredit = parseFloat(supplier.creditLimit || "0");
      let newBalance = currentBalance;
      let newCredit = currentCredit;

      if (operation === "add_balance") {
        newBalance = currentBalance + amt;
      } else if (operation === "add_credit") {
        newCredit = currentCredit + amt;
      } else if (operation === "deduct_balance") {
        newBalance = Math.max(0, currentBalance - amt);
      } else if (operation === "deduct_credit") {
        newCredit = Math.max(0, currentCredit - amt);
      } else if (operation === "set_balance") {
        newBalance = amt;
      } else if (operation === "set_credit") {
        newCredit = amt;
      } else {
        newBalance = currentBalance + amt;
      }

      const [updated] = await db.update(suppliers).set({
        currentBalance: String(newBalance),
        creditLimit: String(newCredit),
        updatedAt: new Date(),
      }).where(eq(suppliers.id, entityId)).returning();

      return NextResponse.json({
        success: true,
        previousBalance: String(currentBalance),
        previousCredit: String(currentCredit),
        newBalance: String(newBalance),
        newCredit: String(newCredit),
        totalAvailable: newBalance + newCredit,
        operation,
      });
    }

    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
