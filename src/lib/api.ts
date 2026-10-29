export type ProductStatus = "draft" | "active" | "inactive";
export type CategoryStatus = "active" | "inactive";

export interface CurrentUser {
  authorized: boolean;
  email: string | null;
  role: "owner" | null;
  reason?: "owner_not_configured" | "email_not_approved" | "email_not_verified";
}

export interface Category {
  id: number;
  name: string;
  description: string | null;
  status: CategoryStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: number;
  sku: string;
  name: string;
  description: string | null;
  brand: string | null;
  categoryId: number | null;
  supplierName: string | null;
  supplierProductCode: string | null;
  purchaseCurrency: string;
  purchasePrice: string | null;
  estimatedLandedCostZmw: string | null;
  sellingPriceZmw: string | null;
  estimatedGrossProfitZmw: string | null;
  estimatedGrossMarginPercent: string | null;
  reorderThreshold: number;
  unit: string;
  status: ProductStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProductInput {
  sku: string;
  name: string;
  description: string | null;
  brand: string | null;
  categoryId: number | null;
  supplierName: string | null;
  supplierProductCode: string | null;
  purchaseCurrency: string;
  purchasePrice: string | null;
  estimatedLandedCostZmw: string | null;
  sellingPriceZmw: string | null;
  reorderThreshold: number;
  unit: string;
  status: ProductStatus;
}

export interface ProductListParams {
  q?: string;
  status?: "all" | ProductStatus;
  categoryId?: number;
  page?: number;
  pageSize?: number;
}

export interface ProductListResult {
  products: Product[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  } & T;
  if (!response.ok) {
    throw new ApiError(body.error ?? "The request could not be completed.", response.status);
  }
  return body;
}

export async function fetchCurrentUser(): Promise<CurrentUser> {
  return request<CurrentUser>("/api/me");
}

export async function fetchCategories(): Promise<Category[]> {
  const result = await request<{ categories: Category[] }>("/api/categories");
  return result.categories;
}

export async function createCategory(input: {
  name: string;
  description: string | null;
}): Promise<Category> {
  const result = await request<{ category: Category }>("/api/categories", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.category;
}

export async function updateCategory(
  id: number,
  input: { name: string; description: string | null; status: CategoryStatus },
): Promise<Category> {
  const result = await request<{ category: Category }>(`/api/categories/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  return result.category;
}

export async function fetchProducts(
  params: ProductListParams = {},
): Promise<ProductListResult> {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.status) query.set("status", params.status);
  if (params.categoryId) query.set("categoryId", String(params.categoryId));
  if (params.page) query.set("page", String(params.page));
  if (params.pageSize) query.set("pageSize", String(params.pageSize));
  const result = await request<ProductListResult>(`/api/products?${query.toString()}`);
  return result;
}

export async function createProduct(input: ProductInput): Promise<Product> {
  const result = await request<{ product: Product }>("/api/products", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.product;
}

export async function updateProduct(id: number, input: ProductInput): Promise<Product> {
  const result = await request<{ product: Product }>(`/api/products/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
  return result.product;
}
