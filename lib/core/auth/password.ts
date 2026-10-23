import bcrypt from "bcryptjs";

const ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash || !plain) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/** 固定時間比對用的假雜湊（帳號不存在時也跑一次 bcrypt，避免以回應時間探測帳號是否存在） */
export const DUMMY_HASH = "$2a$10$CwTycUXWue0Thq9StjUM0uJ8.4fG9gJp1oCk5c6f1dYj0h6kQe1yW";
