from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models


class UserManager(BaseUserManager):
    def create_user(self, email, password=None, **extra_fields):
        if not email:
            raise ValueError('Email is required')
        email = self.normalize_email(email)
        user = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault('is_staff', True)
        extra_fields.setdefault('is_superuser', True)
        return self.create_user(email, password, **extra_fields)


class User(AbstractBaseUser, PermissionsMixin):
    email = models.EmailField(unique=True)
    full_name = models.CharField(max_length=150, blank=True)
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    objects = UserManager()

    USERNAME_FIELD = 'email'
    REQUIRED_FIELDS = []

    def __str__(self):
        return self.email


class WhiteboardSession(models.Model):
    """A saved Excalidraw whiteboard. `scene` holds the JSON (elements +
    appState + files); `thumbnail` is a small PNG preview for the library."""
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='whiteboards')
    title = models.CharField(max_length=255)
    scene = models.TextField()
    thumbnail = models.FileField(upload_to='whiteboards/', blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated_at']

    def __str__(self):
        return f'{self.title} ({self.user.email})'


class Animation(models.Model):
    """A Manim animation generated for a user. Created on every generation;
    `saved` flips to True only if the user chooses to keep it."""
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='animations')
    title = models.CharField(max_length=255)
    prompt = models.TextField(blank=True)
    code = models.TextField(blank=True)
    video = models.FileField(upload_to='animations/')
    saved = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.title} ({self.user.email})'
