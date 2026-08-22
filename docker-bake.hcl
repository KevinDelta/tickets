variable "IMAGE_TAG" {
  default = "tourbook-tickets:integration"
}

group "default" {
  targets = ["integration"]
}

target "integration" {
  context    = "."
  dockerfile = "Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = [IMAGE_TAG]
}
