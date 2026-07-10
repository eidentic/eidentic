import type { Browser, BrowserContext, Page } from "playwright-core";
import type {
  BrowserContextFactory,
  BrowserContextLike,
  ManagedPageLike,
} from "../src/index.js";

declare const browser: Browser;
declare const context: BrowserContext;
declare const page: Page;

const compatibleContext: BrowserContextLike = context;
const compatiblePage: ManagedPageLike = page;
const compatibleFactory: BrowserContextFactory = async ({ contextOptions }) =>
  browser.newContext(contextOptions);

void compatibleContext;
void compatiblePage;
void compatibleFactory;
