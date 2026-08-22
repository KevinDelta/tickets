variable "IMAGE_TAG" {
  default = "tourbook-tickets:integration"
}

variable "SOURCE_COMMIT" {
  default = "unknown"
}

group "default" {
  targets = ["integration"]
}

target "integration" {
  args = {
    SOURCE_COMMIT = SOURCE_COMMIT
  }
  context    = "."
  dockerfile = "Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = [IMAGE_TAG]
}
