// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  integrations: [
    starlight({
      title: "Eidentic",
      description:
        "Production-grade agentic AI for TypeScript — self-improving memory, self-developing skills, and multi-agent orchestration.",
      social: {
        github: "https://github.com/eidentic/eidentic",
      },
      customCss: ["./src/custom.css"],
      sidebar: [
        {
          label: "Getting Started",
          link: "/getting-started",
        },
        {
          label: "Guides",
          items: [
            {
              label: "Core",
              items: [
                { label: "Next.js Integration", link: "/guides/nextjs" },
                { label: "Building your own UI", link: "/guides/building-your-own-ui" },
                { label: "Runtimes", link: "/guides/runtimes" },
                { label: "Deployment", link: "/guides/deployment" },
              ],
            },
            {
              label: "Agent",
              items: [
                { label: "Memory 101", link: "/guides/memory" },
                { label: "Memory Governance", link: "/guides/memory-governance" },
                { label: "Structured Output", link: "/guides/structured-output" },
                { label: "Tools & Web Search", link: "/guides/tools" },
                { label: "Agent Hooks", link: "/guides/agent-hooks" },
                { label: "Citations & Grounded Outputs", link: "/guides/citations" },
              ],
            },
            {
              label: "Workflows",
              items: [
                { label: "Workflows", link: "/guides/workflows" },
              ],
            },
            {
              label: "Server",
              items: [
                { label: "Server & Studio", link: "/guides/server-studio" },
                { label: "Server Production Guide", link: "/guides/server-hardening" },
              ],
            },
            {
              label: "Frontend",
              items: [
                { label: "React Hooks Reference", link: "/guides/react-hooks" },
              ],
            },
            {
              label: "Models & Cost",
              items: [
                { label: "Model Routing & Cost Recipes", link: "/guides/model-routing" },
                { label: "Prompt Versioning", link: "/guides/prompt-versioning" },
              ],
            },
            {
              label: "Quality & Operations",
              items: [
                { label: "Observability", link: "/guides/observability" },
                { label: "Evals in CI", link: "/guides/evals-ci" },
                { label: "Benchmarks", link: "/guides/benchmarks" },
                { label: "Browser Tools", link: "/guides/browser-tools" },
              ],
            },
            {
              label: "Data & Compliance",
              items: [
                { label: "Data Residency & Local Models", link: "/guides/data-residency" },
                { label: "Stability & Versioning", link: "/guides/stability" },
              ],
            },
          ],
        },
        {
          label: "API Reference",
          link: "/reference",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/eidentic/eidentic/edit/main/docs-site/",
      },
    }),
  ],
});
